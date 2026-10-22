import { NextResponse } from 'next/server';
import { readAnio, readClienteLineaAnio } from '@/lib/hgi/ventasMensualStore';
import { hoyColombia } from '@/lib/hgi/ventas';
import { clientesPorZona, resumenZonas, detalleZona } from '@/lib/hgi/comercial';
import { ZONA_TODAS, ordenZona } from '@/lib/hgi/zonas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Apartado Comercial (vendedores): venta acumulada del AÑO EN CURSO con corte a
 * hoy, por zona comercial (zona = vendedor, lib/hgi/zonas.ts).
 *
 *  - parte=zonas (default)   → resumen por zona: "Todas las zonas", Zona 1..N y
 *                              "Sin zona". Mismo cálculo que el pareto de Gerencia.
 *  - parte=zona&zona=…       → pareto de clientes de esa zona, con compra por mes.
 *  - parte=cliente&nit=…     → un cliente: compras por mes (de por_zona, el mismo
 *                              dato del pareto) y línea × año (de por_cliente_linea,
 *                              migración 011), uniendo los meses del año.
 *
 * Sin roles: todos ven todas las zonas. Las lecturas a Postgres van EN SERIE
 * (trampa 2 del pooler en CLAUDE.md).
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Meses del año en curso hasta el actual, y la fila de cada uno. */
async function periodo(hoy: string) {
  const anio = hoy.slice(0, 4);
  const mesTope = Number(hoy.slice(5, 7));
  const meses = await readAnio(anio);
  const lista = Array.from({ length: mesTope }, (_, i) => `${anio}-${pad(i + 1)}`);
  const zonas = clientesPorZona(
    lista.map((mes) => ({ mes, zonas: meses.find((m) => m.mes === mes)?.porZona ?? null })),
  );
  // Corte real: el `hasta` del último mes construido (el mes en curso se
  // refresca cada ~90 min, así que puede ir unas horas detrás de hoy).
  const ultimo = meses.filter((m) => lista.includes(m.mes)).at(-1);
  return { anio, lista, zonas, corte: ultimo?.hasta || null };
}

interface LineaAnio {
  linea: string;
  venta: number;
  unidades: number;
  /** Venta por mes, alineada con `meses`. */
  porMes: number[];
}

async function vistaCliente(hoy: string, nit: string) {
  const { anio, lista, zonas, corte } = await periodo(hoy);
  const avisos: string[] = [];

  // Compras por mes: del consolidado "Todas las zonas", igual que el pareto.
  const todas = zonas.zonas.find((z) => z.zona === ZONA_TODAS);
  const fila = todas?.clientes.find((c) => c.nit === nit) ?? null;
  // Zonas que lo atendieron en el año (un cliente puede estar en dos).
  const enZonas = zonas.zonas
    .filter((z) => z.zona !== ZONA_TODAS)
    .flatMap((z) => {
      const c = z.clientes.find((x) => x.nit === nit);
      return c ? [{ zona: z.zona, venta: c.venta }] : [];
    })
    .sort((a, b) => ordenZona(a.zona) - ordenZona(b.zona));

  // Línea × año: por_cliente_linea, filtrado por NIT en Postgres.
  const porMesLinea = (await readClienteLineaAnio(anio, nit)).filter((r) => lista.includes(r.mes));
  const lineas = new Map<string, LineaAnio>();
  let nombre = fila?.nombre ?? '';
  for (const r of porMesLinea) {
    const i = lista.indexOf(r.mes);
    for (const f of r.filas ?? []) {
      nombre ||= f.nombre;
      const e = lineas.get(f.linea) ?? { linea: f.linea, venta: 0, unidades: 0, porMes: new Array<number>(lista.length).fill(0) };
      e.venta += f.venta;
      e.unidades += f.unidades;
      e.porMes[i] += f.venta;
      lineas.set(f.linea, e);
    }
  }
  const construidos = new Set(porMesLinea.filter((r) => r.filas).map((r) => r.mes));
  const lineaSinDato = lista.filter((m) => !construidos.has(m));
  if (lineaSinDato.length) {
    avisos.push(`Línea de producto sin construir para ${lineaSinDato.join(', ')}: la tabla por línea no incluye esos meses.`);
  }
  if (!fila && lineas.size === 0) avisos.push(`El NIT ${nit} no tiene compras en ${anio}.`);

  const lineasOrd = [...lineas.values()].sort((a, b) => b.venta - a.venta);
  return {
    ok: true,
    anio,
    corte,
    meses: lista,
    cliente: {
      nit,
      nombre: nombre || nit,
      venta: fila?.venta ?? 0,
      porMes: fila?.porMes ?? new Array<number>(lista.length).fill(0),
      zonas: enZonas,
    },
    lineas: lineasOrd,
    totalLineas: lineasOrd.reduce((s, l) => s + l.venta, 0),
    mesesSinDato: zonas.mesesSinDato,
    lineaSinDato,
    avisos,
  };
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const hoy = hoyColombia();
  const parte = sp.get('parte') ?? 'zonas';

  try {
    if (parte === 'cliente') {
      const nit = (sp.get('nit') ?? '').trim();
      if (!nit) return NextResponse.json({ ok: false, mensaje: 'Falta nit' }, { status: 400 });
      return NextResponse.json(await vistaCliente(hoy, nit));
    }

    const { anio, zonas, corte } = await periodo(hoy);
    if (parte === 'zona') {
      return NextResponse.json({ ok: true, anio, corte, zonaDetalle: detalleZona(zonas, sp.get('zona') ?? '') });
    }
    const avisos = zonas.mesesSinDato.length ? [`Sin datos de zona para ${zonas.mesesSinDato.join(', ')}.`] : [];
    return NextResponse.json({ ok: true, anio, corte, ...resumenZonas(zonas), avisos });
  } catch (err) {
    // Degradación: la vista se dibuja vacía con aviso, nunca un 500 que la tumbe.
    const mensaje = (err as Error).message;
    console.error(`[comercial] falló: ${mensaje}`);
    return NextResponse.json({ ok: false, mensaje, avisos: [`No se pudieron calcular los indicadores (${mensaje}).`] });
  }
}
