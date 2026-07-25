import { getValidToken } from './client';
import { fetchRango, hoyColombia, trocear, type Rango } from './ventas';
import { totales, agrupar, type VentaLinea } from './mappers/ventas';
import { readCobertura, writeMes, type MesAgregado } from './ventasMensualStore';

/**
 * Backfill de agregados mensuales de ventas.
 *
 * Por qué existe: el snapshot `ventas` guarda líneas de UN mes (el corriente) y
 * el anterior sólo como total — ver la nota en buildVentasSnapshot. Sin esto no
 * hay forma de calcular un año ni un comparativo interanual.
 *
 * Por qué un mes por corrida: ObtenerDetalleReporte aguanta mal los rangos
 * largos (23 días tardan 40-120s, de ahí las ventanas de 5 días). Un año son
 * ~73 ventanas y no cabe en maxDuration=300. El cron corre cada hora y rellena
 * un mes, así que HORIZONTE_MESES meses quedan cubiertos en otras tantas horas,
 * sin castigar a HGINet ni competir con los demás datasets.
 *
 * Orden de prioridad de la corrida:
 *  1. El mes en curso, si su agregado tiene más de REFRESCO_PARCIAL_MIN minutos.
 *     Está abierto (crece cada día), así que hay que revisitarlo.
 *  2. El mes cerrado más reciente que falte, dentro del horizonte. Del más nuevo
 *     al más viejo: el año en curso se completa antes que el anterior.
 * Un mes cerrado ya construido NO se vuelve a pedir: su cifra es definitiva.
 */

/** Meses hacia atrás que se mantienen. 24 = año en curso + año anterior completo. */
export const HORIZONTE_MESES = 24;
/** El mes en curso se reconstruye si su agregado es más viejo que esto. */
const REFRESCO_PARCIAL_MIN = 90;

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' del mes al que pertenece una fecha ISO corta. */
export const mesDe = (iso: string) => iso.slice(0, 7);

/** Último día del mes (m es 1..12), sin sorpresas de zona horaria. */
const ultimoDia = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Rango consultable de un mes. Para el mes en curso se corta en `hoy`. */
export function rangoDeMes(mes: string, hoy = hoyColombia()): Rango {
  const [y, m] = mes.split('-').map(Number);
  const desde = `${y}-${pad(m)}-01`;
  const finMes = `${y}-${pad(m)}-${pad(ultimoDia(y, m))}`;
  return { desde, hasta: finMes > hoy ? hoy : finMes };
}

/** Los HORIZONTE_MESES meses hasta el actual, del más nuevo al más viejo. */
export function mesesDelHorizonte(hoy = hoyColombia()): string[] {
  const [y, m] = hoy.slice(0, 7).split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < HORIZONTE_MESES; i++) {
    const total = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(total / 12)}-${pad((total % 12) + 1)}`);
  }
  return out;
}

/**
 * Decide qué mes construye esta corrida. `null` = nada que hacer (horizonte
 * completo y el mes en curso fresco).
 */
export function elegirMes(
  cobertura: Array<{ mes: string; parcial: boolean; builtAt: Date }>,
  hoy = hoyColombia(),
  ahora = Date.now(),
): string | null {
  const mesActual = mesDe(hoy);
  const porMes = new Map(cobertura.map((c) => [c.mes, c]));

  const actual = porMes.get(mesActual);
  if (!actual || ahora - actual.builtAt.getTime() > REFRESCO_PARCIAL_MIN * 60_000) {
    return mesActual;
  }

  // Meses cerrados que falten, del más reciente al más antiguo.
  for (const mes of mesesDelHorizonte(hoy)) {
    if (mes === mesActual) continue;
    if (!porMes.has(mes)) return mes;
  }
  return null;
}

/** Agrega las líneas de un mes a la fila que se persiste. */
export function agregarMes(mes: string, lineas: VentaLinea[], rango: Rango, parcial: boolean): Omit<MesAgregado, 'builtAt'> {
  const t = totales(lineas);
  const nits = new Set<string>();
  for (const l of lineas) if (l.nitTercero) nits.add(l.nitTercero);

  return {
    mes,
    venta: t.venta,
    costo: t.costo,
    margen: t.margen,
    iva: t.iva,
    descuento: t.descuento,
    lineas: t.lineas,
    documentos: t.documentos,
    clientesNits: [...nits],
    // Se guardan 50, no 10: el top-10 ANUAL se calcula uniendo los rankings
    // mensuales, y con sólo 10 por mes un cliente constante en el puesto 11 se
    // perdería del año entero. Con 50 el ranking anual es exacto salvo casos
    // irreales (quedar fuera del top-50 los doce meses y aun así entrar al
    // top-10 del año).
    topClientes: agrupar(lineas, (l) => l.nitTercero, (l) => l.tercero, 50),
    topProductos: agrupar(lineas, (l) => l.codigoProducto, (l) => l.producto, 50),
    porLinea: agrupar(lineas, (l) => l.linea, (l) => l.linea),
    porVendedor: agrupar(lineas, (l) => l.vendedor, (l) => l.vendedor),
    hasta: rango.hasta,
    parcial,
  };
}

export interface RefreshMensualResultado {
  mes: string | null;
  motivo: string;
  lineas?: number;
  documentos?: number;
  ventanas?: number;
  buildMs?: number;
  cobertura: { meses: number; horizonte: number; faltan: string[] };
}

/**
 * Una corrida del backfill: elige un mes, lo trae de HGINet y lo persiste.
 * Idempotente — reejecutar el mismo mes reescribe la misma fila.
 */
export async function refreshVentasMensual(mesForzado?: string): Promise<RefreshMensualResultado> {
  await getValidToken(); // prime del token cacheado

  const hoy = hoyColombia();
  const cobertura = await readCobertura();
  const mes = mesForzado ?? elegirMes(cobertura, hoy);

  const resumenCobertura = () => {
    const presentes = new Set(cobertura.map((c) => c.mes));
    return {
      meses: cobertura.length,
      horizonte: HORIZONTE_MESES,
      faltan: mesesDelHorizonte(hoy).filter((m) => !presentes.has(m)),
    };
  };

  if (!mes) {
    return { mes: null, motivo: 'horizonte completo y mes en curso fresco', cobertura: resumenCobertura() };
  }

  const mesActual = mesDe(hoy);
  const rango = rangoDeMes(mes, hoy);
  const t0 = Date.now();
  const lineas = await fetchRango(rango);
  const fila = agregarMes(mes, lineas, rango, mes === mesActual);
  await writeMes(fila);

  return {
    mes,
    motivo: mesForzado ? 'mes forzado por parámetro' : mes === mesActual ? 'mes en curso (parcial)' : 'backfill de mes cerrado',
    lineas: fila.lineas,
    documentos: fila.documentos,
    ventanas: trocear(rango).length,
    buildMs: Date.now() - t0,
    cobertura: resumenCobertura(),
  };
}
