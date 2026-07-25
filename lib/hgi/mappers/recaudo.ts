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
 *
 * ============ LA FUENTE ES ObtenerRecaudo. NO MIGRAR A PorVendedor ============
 *
 * `codigoVendedor`, `codigoLocal`, `cuota`, `fechaVencimiento`, `numeroPago` y
 * `codigoClase` salen de **Api/Cartera/ObtenerRecaudo**, que ya los devolvía: la
 * proyección vieja simplemente no los copiaba. Vienen 5.843/5.843 en 2026-07.
 *
 * Existe `Api/Cartera/ObtenerRecaudoPorVendedor` y parece el candidato natural
 * "porque trae vendedor". NO SIRVE COMO FUENTE. Medido sobre el mismo mes
 * (2026-07-01..24), mismo troceo por día:
 *
 *              ObtenerRecaudo   ObtenerRecaudoPorVendedor
 *   filas             5.843              2.324
 *   claves op.        3.594              2.324
 *   importe   $1.145.120.305     $1.145.120.305
 *
 * Mismo dinero en 60% menos filas: **colapsa el desglose por concepto**. Aquí una
 * aplicación de pago con descuento son DOS filas ("PAGO FACTURA CLIENTE" $269.330
 * y "DESCUENTO EN VENTA" $13.466); allí es una. Y 1.270 claves de operación
 * existen en ObtenerRecaudo y no en el otro.
 *
 * Peor: PorVendedor devuelve las tres descripciones en NULL
 * (`DescripcionConcepto` 0/2.324 contra 5.843/5.843 aquí). Como `esRecaudo` se
 * deriva de `DescripcionConcepto`, migrar dejaría todo clasificado como recaudo,
 * `totalAjustes` en 0 y el KPI de caja inflado — una regresión silenciosa sobre
 * una cifra financiera. Los campos que se buscaban ya estaban aquí; lo único que
 * aportaba el otro endpoint era el eje `tipo_pago` (CxP), hoy casi vacío.
 * ============================================================================
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

  // ---- Campos que el endpoint ya traía y la proyección descartaba ----
  // Verificado sobre 2026-07: los seis vienen poblados 5.843/5.843 en
  // ObtenerRecaudo. Ver la nota de fuente en la cabecera de este archivo.
  /** Código del vendedor, además del nombre que ya se proyectaba. */
  codigoVendedor: string;
  /** Local/sucursal. Su descripción (`DescripcionLocal`) queda en `local`. */
  codigoLocal: string;
  /** Cuota del documento sobre la que se aplicó el pago. */
  cuota: string;
  /** Vencimiento de la cuota; con `fechaPago` da la mora real, no sólo `edad`. */
  fechaVencimiento: string;
  /** Número del recibo de pago. Junto a documento+cuota identifica la aplicación. */
  numeroPago: string;
  /** Clase de cartera del documento. Su descripción queda en `clase`. */
  codigoClase: string;
  /** Descripciones que HGINet sí devuelve en este endpoint (y no en el otro). */
  clase: string;
  local: string;
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

      // Ensanchado ADITIVO: sólo se agregan campos a la fila proyectada. Ningún
      // agregado de aggregateRecaudo los lee, así que las cifras (totalRecaudo,
      // totalAjustes, operaciones, terceros, pctAlDia, porDia, porVendedor,
      // porConcepto, topClientes) no se mueven ni un peso.
      codigoVendedor: str(d.CodigoVendedor),
      codigoLocal: str(d.CodigoLocal),
      cuota: str(d.Cuota),
      fechaVencimiento: str(d.FechaVencimiento).slice(0, 10),
      numeroPago: str(d.NumeroPago),
      codigoClase: str(d.CodigoClase),
      clase: str(d.DescripcionClase),
      local: str(d.DescripcionLocal),
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
