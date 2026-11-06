import { hoyColombia } from '../ventas';
import { mesesHasta } from '../descuentos/refresh';
import {
  BODEGAS,
  calcularProducto,
  esComodin,
  movVacio,
  porProveedor,
  sinTraslados,
  type InfoProducto,
  type Movimiento,
  type ProductoRot,
  type ProveedorRot,
} from './mappers';
import { MES_INICIAL_ROT } from './ingest';
import { readMesesOkRot, readMovimiento, readProductos, readSaldos } from './store';

/**
 * Arma el informe de rotación de un periodo (lo usan /api/rotacion y su .xlsx).
 * Lecturas EN SERIE (cliente max:1). Ver docs/ROTACION.md.
 */

export const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
export const BODEGA_TODAS = 'todas';
export const DIAS_OBJETIVO = [15, 30, 45, 60, 90] as const;

export interface ParametrosRot {
  desde: string; // YYYY-MM
  hasta: string; // YYYY-MM
  bodega: string; // '01' | '02' | '03' | '0' | 'todas'
  diasObjetivo: number;
}

export function validarParametros(url: URL): { ok: true; p: ParametrosRot } | { ok: false; mensaje: string } {
  const hoy = hoyColombia();
  const actual = hoy.slice(0, 7);
  const desde = url.searchParams.get('desde') ?? '';
  const hasta = url.searchParams.get('hasta') ?? '';
  const bodega = url.searchParams.get('bodega') ?? '01';
  const diasObjetivo = Number(url.searchParams.get('dias') ?? '30');
  if (!MES.test(desde) || !MES.test(hasta) || desde > hasta) return { ok: false, mensaje: 'desde/hasta deben ser YYYY-MM y desde ≤ hasta' };
  if (desde < MES_INICIAL_ROT) return { ok: false, mensaje: `El histórico empieza en ${MES_INICIAL_ROT}` };
  if (hasta > actual) return { ok: false, mensaje: 'hasta no puede ser un mes futuro' };
  if (bodega !== BODEGA_TODAS && !(bodega in BODEGAS)) return { ok: false, mensaje: 'Bodega inválida' };
  if (!(DIAS_OBJETIVO as readonly number[]).includes(diasObjetivo)) return { ok: false, mensaje: `dias debe ser uno de ${DIAS_OBJETIVO.join(', ')}` };
  return { ok: true, p: { desde, hasta, bodega, diasObjetivo } };
}

const siguienteMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const finDeMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

export interface Kpis {
  productos: number;
  valorExistencia: number;
  diasInventario: number | null;
  agotados: number;
  porAgotarse: number;
  sinMovimiento: number;
  valorSinMovimiento: number;
  sobrestock: number;
  valorSugerido: number;
}

export interface InformeRot {
  completo: boolean;
  /** Meses que faltan por ingestar entre `desde` y hoy (sin ellos inicial/final no son exactos). */
  mesesSinDatos: string[];
  mesesDisponibles: string[];
  desde: string;
  hasta: string;
  bodega: string;
  diasObjetivo: number;
  /** Días del periodo (si incluye el mes en curso, hasta hoy). */
  dias: number;
  incluyeMesAbierto: boolean;
  existenciasTomadasEn: string | null;
  kpis: Kpis | null;
  proveedores: ProveedorRot[];
  productos: ProductoRot[];
}

export async function armarInforme(p: ParametrosRot): Promise<InformeRot> {
  const hoy = hoyColombia();
  const actual = hoy.slice(0, 7);
  const disponibles = (await readMesesOkRot()).sort();
  const ok = new Set(disponibles);
  const necesarios = mesesHasta(hoy, p.desde);
  const mesesSinDatos = necesarios.filter((m) => !ok.has(m));
  const base = {
    mesesSinDatos,
    mesesDisponibles: disponibles,
    desde: p.desde,
    hasta: p.hasta,
    bodega: p.bodega,
    diasObjetivo: p.diasObjetivo,
    incluyeMesAbierto: p.hasta === actual,
  };
  const finPeriodo = p.hasta === actual ? hoy : finDeMes(p.hasta);
  const dias = diasEntre(`${p.desde}-01`, finPeriodo);

  // Sin TODOS los meses desde `desde` hasta hoy, inicial y final serían inventados: no se entregan cifras.
  if (mesesSinDatos.length) {
    return { ...base, completo: false, dias, existenciasTomadasEn: null, kpis: null, proveedores: [], productos: [] };
  }

  const bodegas = p.bodega === BODEGA_TODAS ? null : [p.bodega];
  const ajustarTodas = (m: Map<string, Movimiento>) => new Map([...m].map(([k, v]) => [k, sinTraslados(v)] as const));
  const ajustar = (m: Map<string, Movimiento>) => (bodegas ? m : ajustarTodas(m));
  const periodo = ajustar(await readMovimiento(p.desde, p.hasta, bodegas));
  const posterior = p.hasta < actual ? ajustar(await readMovimiento(siguienteMes(p.hasta), actual, bodegas)) : new Map<string, Movimiento>();
  const saldos = await readSaldos(bodegas);
  // Parte de compras: siempre la empresa (todas las bodegas, sin traslados).
  const empresaPeriodo = bodegas ? ajustarTodas(await readMovimiento(p.desde, p.hasta, null)) : periodo;
  const empresaSaldos = bodegas ? await readSaldos(null) : saldos;
  // Inicial y final se calculan desde la existencia actual: sin una toma, no hay cifras.
  if (!saldos.tomadoEn) {
    return { ...base, completo: false, dias, existenciasTomadasEn: null, kpis: null, proveedores: [], productos: [] };
  }
  const info = await readProductos();

  const codigos = new Set([...periodo.keys(), ...posterior.keys(), ...saldos.porProducto.keys()]);
  const productos: ProductoRot[] = [];
  for (const c of codigos) {
    if (esComodin(c)) continue;
    const s = saldos.porProducto.get(c);
    const se = empresaSaldos.porProducto.get(c);
    const pr = calcularProducto(
      {
        info: info.get(c) ?? ({ codigo: c, nombre: c, nitProveedor: '', nombreProveedor: '' } satisfies InfoProducto),
        periodo: periodo.get(c) ?? movVacio(),
        posterior: posterior.get(c) ?? movVacio(),
        existencia: s?.cantidad ?? 0,
        costoUnitario: s?.costoUnitario ?? 0,
        empresa: { periodo: empresaPeriodo.get(c) ?? movVacio(), existencia: se?.cantidad ?? 0, costoUnitario: se?.costoUnitario ?? 0 },
      },
      dias,
      p.diasObjetivo,
    );
    // Productos sin nada en esta bodega (periodo ni existencia): no aportan.
    if (!pr.inicial && !pr.entradas && !pr.salidas && !pr.final && !(s?.cantidad ?? 0)) continue;
    productos.push(pr);
  }
  productos.sort((a, b) => a.nombreProveedor.localeCompare(b.nombreProveedor, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
  const proveedores = porProveedor(productos, dias);
  const total = porProveedor(productos.map((x) => ({ ...x, nitProveedor: '*', nombreProveedor: '*' })), dias)[0];

  const kpis: Kpis | null = total
    ? {
        productos: productos.length,
        valorExistencia: total.valorExistencia,
        diasInventario: total.diasInventario,
        agotados: total.agotados,
        porAgotarse: total.porAgotarse,
        sinMovimiento: total.sinMovimiento,
        valorSinMovimiento: total.valorSinMovimiento,
        sobrestock: productos.filter((x) => x.estado === 'sobrestock').length,
        valorSugerido: total.valorSugerido,
      }
    : null;

  return {
    ...base,
    completo: true,
    dias,
    existenciasTomadasEn: saldos.tomadoEn ? saldos.tomadoEn.toISOString() : null,
    kpis,
    proveedores,
    productos,
  };
}
