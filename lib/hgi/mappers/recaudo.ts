/**
 * Mapper/agregador de Recaudo (HGINet Api/Cartera/ObtenerRecaudo).
 *
 * El endpoint devuelve UNA fila por aplicación de pago sobre una cuota. Ojo:
 * NO todas las filas son plata que entró. `DescripcionConcepto` distingue el
 * recaudo real de los ajustes que también se aplican contra la cartera
 * (descuentos en venta, notas, retenciones). Sumarlas todas infla el recaudo.
 *
 * Verificado en vivo: aparecen conceptos como "GENERAL" (recaudo) y
 * "DESCUENTO EN VENTA" (ajuste). La clasificación es por patrón sobre la
 * descripción, y lo no reconocido cuenta como recaudo real (conservador para
 * el KPI de caja: preferimos revisar de más que ocultar un ingreso).
 */

export interface HgiRecaudoDoc {
  CodigoEmpresa?: number;
  Anyo?: number | string;
  Periodo?: number | string;
  TransaccionDocumento?: string;
  NumeroDocumento?: number | string;
  CodigoTercero?: string | number;
  NombreTercero?: string;
  CodigoLocal?: string;
  Cuota?: string;
  Fecha?: string; // fecha del documento
  FechaVencimiento?: string;
  Edad?: number | string; // días; negativo = pagó antes de vencer
  ValorDetallePago?: number | string;
  InteresDocumento?: number | string;
  CodigoVendedor?: string | number;
  Vendedor?: string;
  FechaPago?: string;
  TransaccionPago?: string;
  NumeroPago?: number | string;
  Concepto?: string | number;
  DescripcionConcepto?: string;
  CodigoClase?: string;
  DescripcionClase?: string;
  [key: string]: unknown;
}

export interface RecaudoLinea {
  fechaPago: string; // YYYY-MM-DD
  fechaDocumento: string;
  documento: string;
  transaccionPago: string;
  codigoTercero: string;
  tercero: string;
  vendedor: string;
  valor: number;
  interes: number;
  edad: number; // días entre vencimiento y pago; <0 = anticipado
  concepto: string;
  /** false = ajuste (descuento/nota/retención), no plata que entró. */
  esRecaudo: boolean;
}

export interface RecaudoPorClave {
  clave: string;
  nombre: string;
  valor: number;
  operaciones: number;
}

export interface RecaudoResumen {
  periodo: { desde: string; hasta: string };
  /** Plata que efectivamente entró. */
  totalRecaudo: number;
  /** Descuentos/notas aplicados contra cartera (NO son caja). */
  totalAjustes: number;
  totalIntereses: number;
  operaciones: number;
  terceros: number;
  /** % de operaciones de recaudo pagadas antes o el día del vencimiento. */
  pctAlDia: number;
  porDia: Array<{ fecha: string; valor: number; operaciones: number }>;
  porVendedor: RecaudoPorClave[];
  porConcepto: RecaudoPorClave[];
  topClientes: RecaudoPorClave[];
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Conceptos que NO son caja: se aplican contra la cartera pero no ingresan
 * dinero. Lo que no matchee se cuenta como recaudo real.
 */
const PATRON_AJUSTE = /DESCUENTO|NOTA|RETENCI|AJUSTE|DEVOLUCI|CASTIGO|ANULA/i;

export const esAjuste = (descripcionConcepto: unknown): boolean => PATRON_AJUSTE.test(str(descripcionConcepto));

export function mapRecaudo(raw: unknown): RecaudoLinea[] {
  if (!Array.isArray(raw)) return [];
  const out: RecaudoLinea[] = [];
  for (const d of raw as HgiRecaudoDoc[]) {
    if (!d || typeof d !== 'object') continue;
    const fechaPago = str(d.FechaPago).slice(0, 10);
    if (!fechaPago) continue;
    const concepto = str(d.DescripcionConcepto) || '(sin concepto)';
    out.push({
      fechaPago,
      fechaDocumento: str(d.Fecha).slice(0, 10),
      documento: str(d.NumeroDocumento),
      transaccionPago: str(d.TransaccionPago),
      codigoTercero: str(d.CodigoTercero),
      tercero: str(d.NombreTercero) || str(d.CodigoTercero),
      vendedor: str(d.Vendedor) || '(sin vendedor)',
      valor: num(d.ValorDetallePago),
      interes: num(d.InteresDocumento),
      edad: num(d.Edad),
      concepto,
      esRecaudo: !esAjuste(concepto),
    });
  }
  return out;
}

function agrupar(
  ls: RecaudoLinea[],
  clave: (l: RecaudoLinea) => string,
  nombre: (l: RecaudoLinea) => string,
  limite?: number,
): RecaudoPorClave[] {
  const m = new Map<string, { nombre: string; valor: number; operaciones: number }>();
  for (const l of ls) {
    const k = clave(l);
    const e = m.get(k) ?? { nombre: nombre(l), valor: 0, operaciones: 0 };
    e.valor += l.valor;
    e.operaciones++;
    m.set(k, e);
  }
  const out = [...m].map(([clave, e]) => ({ clave, nombre: e.nombre, valor: e.valor, operaciones: e.operaciones }));
  out.sort((a, b) => b.valor - a.valor);
  return limite ? out.slice(0, limite) : out;
}

export function aggregateRecaudo(ls: RecaudoLinea[], periodo: { desde: string; hasta: string }): RecaudoResumen {
  const recaudos = ls.filter((l) => l.esRecaudo);
  const ajustes = ls.filter((l) => !l.esRecaudo);

  const porDiaMap = new Map<string, { valor: number; operaciones: number }>();
  for (const l of recaudos) {
    const e = porDiaMap.get(l.fechaPago) ?? { valor: 0, operaciones: 0 };
    e.valor += l.valor;
    e.operaciones++;
    porDiaMap.set(l.fechaPago, e);
  }

  const alDia = recaudos.filter((l) => l.edad <= 0).length;

  return {
    periodo,
    totalRecaudo: recaudos.reduce((a, l) => a + l.valor, 0),
    totalAjustes: ajustes.reduce((a, l) => a + l.valor, 0),
    totalIntereses: recaudos.reduce((a, l) => a + l.interes, 0),
    operaciones: recaudos.length,
    terceros: new Set(recaudos.map((l) => l.codigoTercero)).size,
    pctAlDia: recaudos.length === 0 ? 0 : alDia / recaudos.length,
    porDia: [...porDiaMap]
      .map(([fecha, e]) => ({ fecha, ...e }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha)),
    porVendedor: agrupar(recaudos, (l) => l.vendedor, (l) => l.vendedor),
    // Aquí entran TODAS las filas: el desglose por concepto sirve justamente
    // para ver cuánto de lo aplicado contra cartera no fue caja.
    porConcepto: agrupar(ls, (l) => l.concepto, (l) => l.concepto),
    topClientes: agrupar(recaudos, (l) => l.codigoTercero, (l) => l.tercero, 10),
  };
}
