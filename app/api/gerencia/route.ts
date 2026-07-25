import { NextResponse } from 'next/server';
import { readSnapshot } from '@/lib/hgi/snapshotStore';
import { readAnio, readMes, type MesAgregado } from '@/lib/hgi/ventasMensualStore';
import { hoyColombia } from '@/lib/hgi/ventas';
import { mesDe, mesesDelHorizonte, desplazarMes } from '@/lib/hgi/ventasMensual';
import { totales, agrupar, type VentaLinea, type VentaPorClave } from '@/lib/hgi/mappers/ventas';
import type { CarteraResumen } from '@/lib/hgi/mappers/cartera';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Agregados gerenciales, calculados SIEMPRE server-side.
 *
 * La vista nunca baja el snapshot de ventas (2 MB / 18k líneas) para agrupar en
 * el browser: esta ruta lee el snapshot en el lambda, filtra, agrega y devuelve
 * sólo KPIs, rankings y UNA página de documentos.
 *
 * Dos orígenes según lo que se pida:
 *  - Mes EN CURSO → snapshot `ventas`, que conserva las líneas. Habilita
 *    filtros combinables y la tabla de documentos.
 *  - Mes cerrado y vista de año → tabla hgi_ventas_mensual, que guarda
 *    agregados por mes (el snapshot de ventas no retiene histórico de líneas).
 *    Ahí no hay detalle de línea, así que no hay tabla ni filtros: `detalle:false`.
 */

const MESES_ANIO = 12;
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

interface Kpis {
  venta: number;
  costo: number;
  margen: number;
  margenPct: number;
  documentos: number;
  lineas: number;
  ticketPromedio: number;
  clientesActivos: number;
}

const pct = (margen: number, venta: number) => (venta === 0 ? 0 : margen / venta);
const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
const variacion = (act: number, ant: number): number | null => (ant === 0 ? null : (act - ant) / Math.abs(ant));

interface CarteraKpis {
  totalAbierto: number;
  totalVencido: number;
  pct90: number;
  terceros: number;
}

/**
 * Lee el resumen de cartera del snapshot y devuelve SÓLO los cuatro KPIs que
 * pinta Gerencia. El resumen completo trae buckets, docsCrudos y topDeudores
 * (~4 KB) que esta vista no usa: devolverlo entero engordaría cada respuesta,
 * incluida la de cada cambio de página de la tabla.
 * Best-effort: null si el snapshot no está.
 */
async function carteraResumen(): Promise<CarteraKpis | null> {
  try {
    const snap = await readSnapshot<unknown>('cartera');
    const r = snap?.sourceCounts as unknown as CarteraResumen | undefined;
    if (!r) return null;
    return {
      totalAbierto: r.totalAbierto,
      totalVencido: r.totalVencido,
      pct90: r.pct90,
      terceros: r.terceros,
    };
  } catch {
    return null;
  }
}

/** Une rankings mensuales sumando venta y costo por clave. */
function unirRankings(partes: VentaPorClave[][], limite: number): VentaPorClave[] {
  const m = new Map<string, { nombre: string; venta: number; costo: number; documentos: number }>();
  for (const parte of partes) {
    for (const f of parte) {
      const e = m.get(f.clave) ?? { nombre: f.nombre, venta: 0, costo: 0, documentos: 0 };
      e.venta += f.venta;
      e.costo += f.costo;
      e.documentos += f.documentos;
      m.set(f.clave, e);
    }
  }
  return [...m]
    .map(([clave, e]) => ({
      clave,
      nombre: e.nombre,
      venta: e.venta,
      costo: e.costo,
      margen: e.venta - e.costo,
      margenPct: pct(e.venta - e.costo, e.venta),
      documentos: e.documentos,
    }))
    .sort((a, b) => b.venta - a.venta)
    .slice(0, limite);
}

/** Totales de un conjunto de meses ya agregados. */
function kpisDeMeses(meses: MesAgregado[]): Kpis {
  let venta = 0;
  let costo = 0;
  let documentos = 0;
  let lineas = 0;
  const nits = new Set<string>();
  for (const m of meses) {
    venta += m.venta;
    costo += m.costo;
    documentos += m.documentos;
    lineas += m.lineas;
    // Unión, no suma: el cliente que compra todos los meses cuenta UNA vez.
    for (const n of m.clientesNits) nits.add(n);
  }
  const margen = venta - costo;
  return {
    venta,
    costo,
    margen,
    margenPct: pct(margen, venta),
    documentos,
    lineas,
    ticketPromedio: div(venta, documentos),
    clientesActivos: nits.size,
  };
}

// ---- Vista AÑO ----

async function vistaAnio(anio: string) {
  const avisos: string[] = [];

  // SECUENCIAL a propósito, no Promise.all.
  // El cliente de postgres.js es uno por lambda con max: 1 (ver lib/pg.ts) y va
  // contra el pooler de Supabase en transaction mode. Lanzar estas tres lecturas
  // en paralelo deja los backends en `active` con wait_event Client/ClientRead
  // —la query terminó y Postgres espera al cliente— y la ruta se cuelga hasta el
  // timeout. Son tres queries rápidas sobre índice; encadenarlas no cuesta nada.
  // El resto del código (readThrough, /api/clientes) ya consulta en serie.
  const meses = await readAnio(anio);
  const mesesAnt = await readAnio(String(Number(anio) - 1));
  const cartera = await carteraResumen();

  const kpis = kpisDeMeses(meses);

  // Las 12 casillas del año, con hueco explícito donde el backfill no llegó:
  // pintar 0 sería mentir (0 vendido) donde en realidad es "sin datos".
  const serie = Array.from({ length: MESES_ANIO }, (_, i) => {
    const mes = `${anio}-${String(i + 1).padStart(2, '0')}`;
    const m = meses.find((x) => x.mes === mes);
    return m
      ? { mes, venta: m.venta, costo: m.costo, margen: m.margen, documentos: m.documentos, parcial: m.parcial, sinDatos: false }
      : { mes, venta: 0, costo: 0, margen: 0, documentos: 0, parcial: false, sinDatos: true };
  });

  const comparable = mesesAnt.length > 0;
  const kpisAnt = comparable ? kpisDeMeses(mesesAnt) : null;
  if (!comparable) {
    avisos.push(
      `Sin comparativo interanual: no hay ningún mes de ${Number(anio) - 1} construido todavía. ` +
        'El backfill rellena un mes por hora.',
    );
  }
  const faltan = serie.filter((s) => s.sinDatos).map((s) => s.mes);
  if (faltan.length) {
    avisos.push(`${faltan.length} de 12 meses de ${anio} sin construir (${faltan.join(', ')}).`);
  }

  return {
    ok: true,
    vista: 'anio' as const,
    anio,
    kpis,
    serie,
    anioAnterior: kpisAnt ? { anio: String(Number(anio) - 1), kpis: kpisAnt, mesesConDatos: mesesAnt.length } : null,
    variacion: kpisAnt
      ? {
          venta: variacion(kpis.venta, kpisAnt.venta),
          margen: variacion(kpis.margen, kpisAnt.margen),
          margenPctPuntos: kpisAnt.venta === 0 ? null : kpis.margenPct - kpisAnt.margenPct,
        }
      : null,
    topClientes: unirRankings(meses.map((m) => m.topClientes), 10),
    topProductos: unirRankings(meses.map((m) => m.topProductos), 10),
    porLinea: unirRankings(meses.map((m) => m.porLinea), 15),
    porVendedor: unirRankings(meses.map((m) => m.porVendedor), 15),
    cartera,
    mesesConDatos: meses.length,
    avisos,
  };
}

// ---- Vista MES ----

interface Filtros {
  vendedor: string;
  cliente: string;
  linea: string;
  grupo: string;
}

const aplicaFiltros = (l: VentaLinea, f: Filtros): boolean => {
  if (f.vendedor && l.vendedor !== f.vendedor) return false;
  if (f.linea && l.linea !== f.linea) return false;
  if (f.grupo && l.grupo !== f.grupo) return false;
  if (f.cliente) {
    const q = f.cliente.toLowerCase();
    if (!l.tercero.toLowerCase().includes(q) && !l.nitTercero.toLowerCase().includes(q)) return false;
  }
  return true;
};

/** Serie diaria del mes filtrado. */
function porDia(ls: VentaLinea[]) {
  const m = new Map<string, { venta: number; costo: number; docs: Set<string> }>();
  for (const l of ls) {
    const e = m.get(l.fecha) ?? { venta: 0, costo: 0, docs: new Set<string>() };
    e.venta += l.venta;
    e.costo += l.costo;
    e.docs.add(l.documento);
    m.set(l.fecha, e);
  }
  return [...m]
    .map(([fecha, e]) => ({ fecha, venta: e.venta, costo: e.costo, margen: e.venta - e.costo, documentos: e.docs.size }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Colapsa líneas a documentos (facturas y notas crédito) para la tabla. */
function aDocumentos(ls: VentaLinea[]) {
  const m = new Map<
    string,
    {
      documento: string;
      fecha: string;
      tercero: string;
      nitTercero: string;
      vendedor: string;
      transaccion: string;
      esNotaCredito: boolean;
      numeroPedido: string;
      lineas: number;
      venta: number;
      costo: number;
    }
  >();
  for (const l of ls) {
    const e = m.get(l.documento);
    if (e) {
      e.lineas += 1;
      e.venta += l.venta;
      e.costo += l.costo;
      if (!e.numeroPedido && l.numeroPedido) e.numeroPedido = l.numeroPedido;
    } else {
      m.set(l.documento, {
        documento: l.documento,
        fecha: l.fecha,
        tercero: l.tercero,
        nitTercero: l.nitTercero,
        vendedor: l.vendedor,
        transaccion: l.transaccion,
        esNotaCredito: l.esNotaCredito,
        numeroPedido: l.numeroPedido,
        lineas: 1,
        venta: l.venta,
        costo: l.costo,
      });
    }
  }
  return [...m.values()]
    .map((d) => ({ ...d, margen: d.venta - d.costo, margenPct: pct(d.venta - d.costo, d.venta) }))
    .sort((a, b) => (a.fecha === b.fecha ? b.venta - a.venta : b.fecha.localeCompare(a.fecha)));
}

const opciones = (ls: VentaLinea[], get: (l: VentaLinea) => string) =>
  [...new Set(ls.map(get).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));

async function vistaMes(mes: string, f: Filtros, page: number, pageSize: number) {
  const avisos: string[] = [];
  const esMesActual = mes === mesDe(hoyColombia());
  const cartera = await carteraResumen();

  // Mes cerrado: sólo hay agregados. El snapshot `ventas` no retiene líneas de
  // meses pasados, así que no hay tabla de documentos ni filtros combinables.
  if (!esMesActual) {
    const agg = await readMes(mes);
    if (!agg) {
      return {
        ok: true,
        vista: 'mes' as const,
        mes,
        detalle: false,
        kpis: kpisDeMeses([]),
        serieDia: [],
        filtros: { vendedores: [], lineas: [], grupos: [] },
        topClientes: [],
        topProductos: [],
        porLinea: [],
        porVendedor: [],
        documentos: { page: 1, pageSize, total: 0, filas: [] },
        cartera,
        avisos: [`${mes} no está construido todavía. El backfill rellena un mes por hora, del más reciente al más antiguo.`],
      };
    }
    return {
      ok: true,
      vista: 'mes' as const,
      mes,
      detalle: false,
      kpis: kpisDeMeses([agg]),
      serieDia: [],
      filtros: { vendedores: [], lineas: [], grupos: [] },
      topClientes: agg.topClientes.slice(0, 10),
      topProductos: agg.topProductos.slice(0, 10),
      porLinea: agg.porLinea.slice(0, 15),
      porVendedor: agg.porVendedor.slice(0, 15),
      documentos: { page: 1, pageSize, total: 0, filas: [] },
      cartera,
      avisos: [
        'Mes cerrado: se muestran los agregados guardados. El detalle línea a línea sólo se conserva del mes en curso, ' +
          'así que la tabla de documentos y los filtros no están disponibles aquí.',
      ],
    };
  }

  const snap = await readSnapshot<VentaLinea>('ventas');
  if (!snap) {
    return {
      ok: true,
      vista: 'mes' as const,
      mes,
      detalle: false,
      kpis: kpisDeMeses([]),
      serieDia: [],
      filtros: { vendedores: [], lineas: [], grupos: [] },
      topClientes: [],
      topProductos: [],
      porLinea: [],
      porVendedor: [],
      documentos: { page: 1, pageSize, total: 0, filas: [] },
      cartera,
      avisos: ['Snapshot de ventas no disponible.'],
    };
  }

  // El snapshot de ventas es del mes corriente; se acota por si acaso.
  const delMes = snap.data.filter((l) => mesDe(l.fecha) === mes);
  const filtradas = delMes.filter((l) => aplicaFiltros(l, f));

  const t = totales(filtradas);
  const nits = new Set(filtradas.map((l) => l.nitTercero).filter(Boolean));
  const kpis: Kpis = {
    venta: t.venta,
    costo: t.costo,
    margen: t.margen,
    margenPct: t.margenPct,
    documentos: t.documentos,
    lineas: t.lineas,
    ticketPromedio: div(t.venta, t.documentos),
    clientesActivos: nits.size,
  };

  // Variación mes vs mes anterior. SÓLO sin filtros: comparar un mes filtrado
  // contra el anterior completo daría una caída inventada por el filtro.
  // Dos orígenes, ambos data real: la fila mensual si el backfill ya llegó, y si
  // no, el total de mesAnterior que el builder de `ventas` ya calcula (es
  // exactamente el mes previo al del snapshot, que es el que estamos viendo).
  const sinFiltros = !f.vendedor && !f.linea && !f.grupo && !f.cliente;
  let variacionMes: { venta: number | null; margen: number | null; margenPctPuntos: number | null } | null = null;
  if (sinFiltros) {
    const prev = await readMes(desplazarMes(mes, -1));
    const alt = snap.sourceCounts?.mesAnterior as { venta?: number; margen?: number; margenPct?: number } | undefined;
    const ventaAnt = prev ? prev.venta : alt?.venta;
    const margenAnt = prev ? prev.margen : alt?.margen;
    const margenPctAnt = prev ? pct(prev.margen, prev.venta) : alt?.margenPct;
    if (typeof ventaAnt === 'number' && ventaAnt !== 0) {
      variacionMes = {
        venta: variacion(kpis.venta, ventaAnt),
        margen: typeof margenAnt === 'number' ? variacion(kpis.margen, margenAnt) : null,
        margenPctPuntos: typeof margenPctAnt === 'number' ? kpis.margenPct - margenPctAnt : null,
      };
    }
  }

  const docs = aDocumentos(filtradas);
  const total = docs.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const pageSafe = Math.min(Math.max(1, page), maxPage);
  const filas = docs.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  return {
    ok: true,
    vista: 'mes' as const,
    mes,
    detalle: true,
    kpis,
    serieDia: porDia(filtradas),
    // Las opciones salen del mes SIN filtrar: si salieran del filtrado, elegir un
    // vendedor vaciaría las listas de línea y grupo y no habría cómo volver.
    filtros: {
      vendedores: opciones(delMes, (l) => l.vendedor),
      lineas: opciones(delMes, (l) => l.linea),
      grupos: opciones(delMes, (l) => l.grupo),
    },
    topClientes: agrupar(filtradas, (l) => l.nitTercero, (l) => l.tercero, 10),
    topProductos: agrupar(filtradas, (l) => l.codigoProducto, (l) => l.producto, 10),
    porLinea: agrupar(filtradas, (l) => l.linea, (l) => l.linea, 15),
    porVendedor: agrupar(filtradas, (l) => l.vendedor, (l) => l.vendedor, 15),
    documentos: { page: pageSafe, pageSize, total, filas },
    variacion: variacionMes,
    cartera,
    periodo: snap.sourceCounts?.periodo ?? null,
    builtAt: snap.builtAt.toISOString(),
    avisos,
  };
}

// ---- Handler ----

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const hoy = hoyColombia();

  try {
    const vista = sp.get('vista') === 'anio' ? 'anio' : 'mes';

    if (vista === 'anio') {
      const anio = /^\d{4}$/.test(sp.get('anio') ?? '') ? sp.get('anio')! : hoy.slice(0, 4);
      return NextResponse.json({ ...(await vistaAnio(anio)), mesesDisponibles: mesesDelHorizonte(hoy) });
    }

    const mes = /^\d{4}-\d{2}$/.test(sp.get('mes') ?? '') ? sp.get('mes')! : mesDe(hoy);
    const filtros: Filtros = {
      vendedor: sp.get('vendedor') ?? '',
      cliente: (sp.get('cliente') ?? '').trim(),
      linea: sp.get('linea') ?? '',
      grupo: sp.get('grupo') ?? '',
    };
    const page = Math.max(1, Number(sp.get('page')) || 1);
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(5, Number(sp.get('pageSize')) || PAGE_SIZE_DEFAULT));

    return NextResponse.json({
      ...(await vistaMes(mes, filtros, page, pageSize)),
      mesesDisponibles: mesesDelHorizonte(hoy),
      mesActual: mesDe(hoy),
    });
  } catch (err) {
    // Degradación: la vista se dibuja vacía con aviso, nunca un 500 que la tumbe.
    const mensaje = (err as Error).message;
    console.error(`[gerencia] falló: ${mensaje}`);
    return NextResponse.json({
      ok: false,
      mensaje,
      avisos: [`No se pudieron calcular los indicadores (${mensaje}).`],
    });
  }
}
