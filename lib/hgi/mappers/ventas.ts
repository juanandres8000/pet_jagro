/**
 * Mapper/agregador de Ventas (HGINet Api/Documentos/ObtenerDetalleReporte).
 *
 * El endpoint devuelve UNA fila por línea de factura, con costo y margen. Se usa
 * siempre con tipo_documento=1 (facturas + notas crédito). Verificado en vivo:
 * tipo_documento=0 son pedidos/cotizaciones y 2/3 vienen vacíos.
 *
 * ── DOS REGLAS DURAS, validadas contra la data real ───────────────────────────
 *
 * 1) SÓLO se suman campos de LÍNEA: ValorTotalDetalle, CostoTotal,
 *    ValorDescuentoDetalle, IvaUnitario.
 *    `ValorNeto`, `ValorTotal` e `IvaTotal` son de DOCUMENTO y vienen repetidos
 *    idénticos en cada línea de la factura. Sumarlos multiplica el total por el
 *    número de líneas: en julio 1-23 daban $16.392 M contra $1.582 M reales.
 *
 * 2) El margen se RECALCULA como ValorTotalDetalle − CostoTotal, negando
 *    CostoTotal en las notas crédito. NUNCA se suma el campo `MargenUtilidad`.
 *    Por línea la identidad se cumple, pero en las notas crédito HGINet manda la
 *    venta en negativo y el costo en POSITIVO, así que el campo se rompe en 182
 *    de 16.126 líneas y el total sale inflado ($287,6 M contra $277,2 M reales).
 *    Una nota crédito devuelve mercancía: su costo debe restar, no sumar.
 *
 * 3) La venta NETA es ValorTotalDetalle − ValorDescuentoDetalle. `ValorTotalDetalle`
 *    viene ANTES del descuento de línea. Con la resta, 2025 cuadra al peso con
 *    el reporte del ERP (ene–sep 13.051.972.671 y ene–dic 17.755.191.458); sin
 *    ella el año salía ~2 % inflado. En las notas crédito el descuento llega con
 *    el mismo signo que la venta, así que la misma resta vale para ambas.
 *
 * El IVA de línea se calcula como IvaUnitario × CantidadDocumento. `IvaUnitario`
 * es por unidad: sumarlo crudo no significa nada, y `IvaTotal` es de documento
 * (regla 1). Es la única lectura de IVA coherente a nivel de línea.
 */

export interface HgiVentaLinea {
  Anyo?: number;
  Mes?: number;
  Dia?: number;
  Fecha?: string;
  CodigoProducto?: string | number;
  NombreProducto?: string;
  NombreVendedor?: string;
  CodigoLinea?: string | number;
  NombreLinea?: string;
  CodigoGrupo?: string | number;
  NombreGrupo?: string;
  NitProveedor?: string;
  NombreProveedor?: string;
  CodigoTransaccion?: string | number;
  NombreTransaccion?: string;
  NumeroDocumento?: number | string;
  CodigoBodega?: string | number;
  NombreBodega?: string;
  NitTercero?: string | number;
  NombreTercero?: string;
  NombreCiudadTercero?: string;
  ValorUnitario?: number | string;
  CantidadDocumento?: number | string;
  ValorTotalDetalle?: number | string; // LÍNEA
  CostoTotal?: number | string; // LÍNEA
  CostoUnitario?: number | string; // LÍNEA
  IvaUnitario?: number | string; // LÍNEA (por unidad)
  ValorDescuentoDetalle?: number | string; // LÍNEA
  MargenUtilidad?: number | string; // NO USAR en agregados (ver regla 2)
  ValorNeto?: number | string; // DOCUMENTO — NO SUMAR
  ValorTotal?: number | string; // DOCUMENTO — NO SUMAR
  IvaTotal?: number | string; // DOCUMENTO — NO SUMAR
  NumeroPedido?: number | string;
  [key: string]: unknown;
}

/** Línea proyectada que se guarda en el snapshot (sin FotoProducto ni ruido). */
export interface VentaLinea {
  fecha: string; // ISO corto YYYY-MM-DD
  documento: string;
  transaccion: string;
  esNotaCredito: boolean;
  codigoProducto: string;
  producto: string;
  linea: string; // línea de producto (categoría)
  grupo: string;
  vendedor: string;
  nitTercero: string;
  tercero: string;
  /**
   * NombreCiudadTercero. Es la "zona" de los rankings: NombreZonaTercero viene
   * "GENERAL" en todas las líneas (las zonas no están configuradas en el ERP) y
   * el maestro de terceros tampoco trae zona ni barrio. Medido en sep-2026: 56
   * ciudades, 0 vacías, ningún NIT en más de una ciudad.
   */
  ciudad: string;
  /** NitProveedor del producto. Opcional: las líneas guardadas antes no lo traen. */
  nitProveedor?: string;
  proveedor?: string;
  bodega: string;
  cantidad: number;
  valorUnitario: number;
  /**
   * ValorTotalDetalle, antes del descuento de línea. Opcional porque las líneas
   * guardadas antes de la regla 3 no lo traen: su `venta` es la bruta. Ver
   * `aVentaNeta`.
   */
  ventaBruta?: number;
  venta: number; // NETA: ValorTotalDetalle − ValorDescuentoDetalle (regla 3)
  costo: number; // CostoTotal con signo ya corregido (negativo en notas crédito)
  margen: number; // venta neta − costo
  iva: number; // IvaUnitario × cantidad
  descuento: number;
  numeroPedido: string;
}

export interface VentaTotales {
  venta: number; // neta
  /** Antes del descuento. Es lo que se persiste en hgi_ventas_mensual.venta. */
  ventaBruta: number;
  costo: number;
  margen: number;
  margenPct: number; // 0..1
  iva: number;
  descuento: number;
  lineas: number;
  documentos: number;
}

export interface VentaPorDia {
  fecha: string;
  venta: number;
  costo: number;
  margen: number;
  documentos: number;
}

export interface VentaPorClave {
  clave: string;
  nombre: string;
  venta: number;
  costo: number;
  margen: number;
  margenPct: number;
  documentos: number;
}

export interface VentasResumen {
  periodo: { desde: string; hasta: string };
  mesActual: VentaTotales;
  mesAnterior: VentaTotales;
  /** Variación mes actual vs anterior, 0..n (null si el anterior es 0). */
  variacion: { venta: number | null; margen: number | null; margenPctPuntos: number | null };
  porDia: VentaPorDia[];
  porVendedor: VentaPorClave[];
  porLinea: VentaPorClave[];
  topProductos: VentaPorClave[];
  topClientes: VentaPorClave[];
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Una nota crédito devuelve mercancía: su costo debe restar. */
export const esNotaCredito = (nombreTransaccion: unknown): boolean =>
  /NOTA\s*CREDITO/i.test(str(nombreTransaccion));

/** Fecha ISO corta (YYYY-MM-DD) tolerando el formato de HGINet. */
const fechaCorta = (v: unknown): string => str(v).slice(0, 10);

/** Proyecta una fila cruda de HGINet a la línea que guardamos. */
export function toVentaLinea(f: HgiVentaLinea): VentaLinea | null {
  const fecha = fechaCorta(f.Fecha);
  if (!fecha) return null;

  const nc = esNotaCredito(f.NombreTransaccion);
  const ventaBruta = num(f.ValorTotalDetalle);
  const descuento = num(f.ValorDescuentoDetalle);
  const venta = ventaBruta - descuento; // regla 3
  // Regla 2: el costo de una nota crédito entra negativo.
  const costo = nc ? -num(f.CostoTotal) : num(f.CostoTotal);
  const cantidad = num(f.CantidadDocumento);

  return {
    fecha,
    documento: str(f.NumeroDocumento),
    transaccion: str(f.NombreTransaccion),
    esNotaCredito: nc,
    codigoProducto: str(f.CodigoProducto),
    producto: str(f.NombreProducto) || str(f.CodigoProducto),
    linea: str(f.NombreLinea) || '(sin línea)',
    grupo: str(f.NombreGrupo) || '(sin grupo)',
    vendedor: str(f.NombreVendedor) || '(sin vendedor)',
    nitTercero: str(f.NitTercero),
    tercero: str(f.NombreTercero) || str(f.NitTercero),
    ciudad: str(f.NombreCiudadTercero),
    nitProveedor: str(f.NitProveedor),
    proveedor: str(f.NombreProveedor) || str(f.NitProveedor),
    bodega: str(f.NombreBodega),
    cantidad,
    valorUnitario: num(f.ValorUnitario),
    ventaBruta,
    venta,
    costo,
    margen: venta - costo,
    iva: num(f.IvaUnitario) * cantidad,
    descuento,
    numeroPedido: str(f.NumeroPedido),
  };
}

/**
 * Lleva a neto una línea guardada antes de la regla 3 (sin `ventaBruta`, con la
 * `venta` bruta). Las líneas nuevas pasan tal cual. Hace falta mientras el
 * snapshot `ventas` vigente sea anterior al cambio: se reconstruye solo en el
 * siguiente cron.
 */
export function aVentaNeta(l: VentaLinea): VentaLinea {
  if (l.ventaBruta !== undefined) return l;
  const venta = l.venta - l.descuento;
  return { ...l, ventaBruta: l.venta, venta, margen: venta - l.costo };
}

/** Convierte el array crudo, descartando filas inservibles. */
export function mapVentas(raw: unknown): VentaLinea[] {
  if (!Array.isArray(raw)) return [];
  const out: VentaLinea[] = [];
  for (const f of raw as HgiVentaLinea[]) {
    if (!f || typeof f !== 'object') continue;
    const l = toVentaLinea(f);
    if (l) out.push(l);
  }
  return out;
}

const pct = (margen: number, venta: number) => (venta === 0 ? 0 : margen / venta);

/** Totales sobre un conjunto de líneas. Sólo campos de línea (regla 1). */
export function totales(ls: VentaLinea[]): VentaTotales {
  let venta = 0;
  let ventaBruta = 0;
  let costo = 0;
  let iva = 0;
  let descuento = 0;
  const docs = new Set<string>();
  for (const l of ls) {
    venta += l.venta;
    ventaBruta += l.ventaBruta ?? l.venta + l.descuento;
    costo += l.costo;
    iva += l.iva;
    descuento += l.descuento;
    docs.add(l.documento);
  }
  const margen = venta - costo; // regla 2: recalculado, nunca MargenUtilidad
  return {
    venta,
    ventaBruta,
    costo,
    margen,
    margenPct: pct(margen, venta),
    iva,
    descuento,
    lineas: ls.length,
    documentos: docs.size,
  };
}

/**
 * Agrupa por una clave y devuelve el ranking ordenado por venta desc.
 * Exportada: la usan el agregado mensual y /api/gerencia para rearmar rankings
 * sobre subconjuntos filtrados, con las mismas reglas de margen.
 */
export function agrupar(
  ls: VentaLinea[],
  clave: (l: VentaLinea) => string,
  nombre: (l: VentaLinea) => string,
  limite?: number,
): VentaPorClave[] {
  const m = new Map<string, { nombre: string; venta: number; costo: number; docs: Set<string> }>();
  for (const l of ls) {
    const k = clave(l);
    const e = m.get(k) ?? { nombre: nombre(l), venta: 0, costo: 0, docs: new Set<string>() };
    e.venta += l.venta;
    e.costo += l.costo;
    e.docs.add(l.documento);
    m.set(k, e);
  }
  const out = [...m].map(([clave, e]) => ({
    clave,
    nombre: e.nombre,
    venta: e.venta,
    costo: e.costo,
    margen: e.venta - e.costo,
    margenPct: pct(e.venta - e.costo, e.venta),
    documentos: e.docs.size,
  }));
  out.sort((a, b) => b.venta - a.venta);
  return limite ? out.slice(0, limite) : out;
}

/** Cliente dentro de una zona. Venta neta (regla 3). */
export interface ClienteDeZona {
  nit: string;
  nombre: string;
  venta: number;
  documentos: number;
}

/** Una zona (ciudad del cliente) con TODOS sus clientes, ordenados por venta. */
export interface VentaPorZona {
  zona: string;
  venta: number;
  documentos: number;
  clientes: ClienteDeZona[];
}

/**
 * Venta por zona con la lista COMPLETA de clientes, sin límite: el pareto de
 * clientes por zona necesita la cola entera, no un top-N.
 */
export function porZona(ls: VentaLinea[]): VentaPorZona[] {
  const zonas = new Map<string, { docs: Set<string>; clientes: Map<string, { nombre: string; venta: number; docs: Set<string> }> }>();
  for (const l of ls) {
    const zona = l.ciudad || '(sin ciudad)';
    const z = zonas.get(zona) ?? { docs: new Set<string>(), clientes: new Map() };
    z.docs.add(l.documento);
    const c = z.clientes.get(l.nitTercero) ?? { nombre: l.tercero, venta: 0, docs: new Set<string>() };
    c.venta += l.venta;
    c.docs.add(l.documento);
    z.clientes.set(l.nitTercero, c);
    zonas.set(zona, z);
  }
  return [...zonas]
    .map(([zona, z]) => {
      const clientes = [...z.clientes]
        .map(([nit, c]) => ({ nit, nombre: c.nombre, venta: c.venta, documentos: c.docs.size }))
        .sort((a, b) => b.venta - a.venta);
      return { zona, venta: clientes.reduce((s, c) => s + c.venta, 0), documentos: z.docs.size, clientes };
    })
    .sort((a, b) => b.venta - a.venta);
}

/** Serie diaria ordenada cronológicamente. */
function porDia(ls: VentaLinea[]): VentaPorDia[] {
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

const variacion = (act: number, ant: number): number | null => (ant === 0 ? null : (act - ant) / Math.abs(ant));

/**
 * Arma el resumen gerencial. `mesActual` alimenta gráficos y rankings;
 * `mesAnterior` sólo se usa para el comparativo de los KPIs.
 */
export function aggregateVentas(
  mesActual: VentaLinea[],
  mesAnterior: VentaLinea[],
  periodo: { desde: string; hasta: string },
): VentasResumen {
  const act = totales(mesActual);
  const ant = totales(mesAnterior);

  return {
    periodo,
    mesActual: act,
    mesAnterior: ant,
    variacion: {
      venta: variacion(act.venta, ant.venta),
      margen: variacion(act.margen, ant.margen),
      margenPctPuntos: ant.venta === 0 ? null : act.margenPct - ant.margenPct,
    },
    porDia: porDia(mesActual),
    porVendedor: agrupar(mesActual, (l) => l.vendedor, (l) => l.vendedor),
    porLinea: agrupar(mesActual, (l) => l.linea, (l) => l.linea),
    topProductos: agrupar(mesActual, (l) => l.codigoProducto, (l) => l.producto, 10),
    topClientes: agrupar(mesActual, (l) => l.nitTercero, (l) => l.tercero, 10),
  };
}
