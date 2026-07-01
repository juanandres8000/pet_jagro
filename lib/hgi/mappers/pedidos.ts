/**
 * Mapper: filas planas PedidoPendienteReporte de HGINet → pedidos jerárquicos.
 *
 * El endpoint devuelve UNA fila por línea de pedido. Se agrupan por NumeroDocumento
 * y se filtran las líneas con SaldoFinal > 0 (lo que falta por despachar = lo que se
 * pickea). Los pedidos sin líneas pendientes se descartan.
 *
 * Enriquecimiento para picking: se cruza cada línea con el snapshot de catálogo
 * (por CodigoProducto + CodigoBodega) para añadir stock disponible y, de paso,
 * resolver la descripción del producto (el reporte trae DescripcionProducto = null).
 */

export interface HgiPedidoFila {
  NumeroDocumento?: number | string;
  Id?: number | string;
  FechaDocumento?: string;
  Estado?: string;
  NitTercero?: string | number;
  NombreTercero?: string;
  CodigoZona?: string | number;
  NombreZona?: string;
  CodigoVendedor?: string | number;
  NombreVendedor?: string;
  CodigoTransaccion?: string | number;
  NombreTransaccion?: string;
  CodigoProducto?: string | number;
  DescripcionProducto?: string | null;
  CantidadDocumento?: number | string;
  Despachado?: number | string;
  SaldoFinal?: number | string;
  CodigoBodega?: string | number;
  ValorUnitario?: number | string;
  ValorTotalDetalle?: number | string;
  Observacion?: string;
  [key: string]: unknown;
}

export interface PedidoLinea {
  codigoProducto: string;
  descripcion: string;
  bodega: string;
  cantidadPedida: number;
  despachado: number;
  pendiente: number; // SaldoFinal
  valorUnitario: number;
  valorTotal: number;
  stockDisponible: number | null; // en la bodega de la línea (null si catálogo no disponible)
  stockTotal: number | null; // en todas las bodegas (contexto para picking)
}

export interface Pedido {
  numero: string;
  fecha: string;
  estado: string;
  cliente: { nit: string; nombre: string };
  zona: { codigo: string; nombre: string };
  vendedor: { codigo: string; nombre: string };
  transaccion: { codigo: string; nombre: string };
  observacion?: string;
  lineas: PedidoLinea[];
  totalPendiente: number; // suma de pendiente (unidades)
  valorTotal: number; // suma de valorTotal de las líneas pendientes
}

/** Info de catálogo para enriquecer una línea. */
export interface CatalogoInfo {
  descripcion?: string;
  stockPorBodega?: Record<string, number>;
  stockTotal?: number;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Agrupa las filas planas por pedido, filtra líneas con SaldoFinal>0 y enriquece
 * con stock del catálogo. `catalogo` es opcional: sin él, stock queda en null.
 */
export function mapPedidos(raw: unknown, catalogo?: Map<string, CatalogoInfo>): Pedido[] {
  if (!Array.isArray(raw)) return [];

  const porNumero = new Map<string, Pedido>();

  for (const f of raw as HgiPedidoFila[]) {
    if (!f || typeof f !== 'object') continue;

    const pendiente = num(f.SaldoFinal);
    if (pendiente <= 0) continue; // solo lo que falta por despachar

    const numero = str(f.NumeroDocumento);
    if (!numero) continue;

    const codigoProducto = str(f.CodigoProducto);
    const cat = catalogo?.get(codigoProducto);
    const bodega = str(f.CodigoBodega);

    const linea: PedidoLinea = {
      codigoProducto,
      // El reporte trae DescripcionProducto=null → resolver del catálogo.
      descripcion: str(f.DescripcionProducto) || cat?.descripcion || codigoProducto,
      bodega,
      cantidadPedida: num(f.CantidadDocumento),
      despachado: num(f.Despachado),
      pendiente,
      valorUnitario: num(f.ValorUnitario),
      valorTotal: num(f.ValorTotalDetalle),
      stockDisponible: cat ? (cat.stockPorBodega?.[bodega] ?? 0) : null,
      stockTotal: cat ? (cat.stockTotal ?? 0) : null,
    };

    let pedido = porNumero.get(numero);
    if (!pedido) {
      pedido = {
        numero,
        fecha: str(f.FechaDocumento),
        estado: str(f.Estado),
        cliente: { nit: str(f.NitTercero), nombre: str(f.NombreTercero) },
        zona: { codigo: str(f.CodigoZona), nombre: str(f.NombreZona) },
        vendedor: { codigo: str(f.CodigoVendedor), nombre: str(f.NombreVendedor) },
        transaccion: { codigo: str(f.CodigoTransaccion), nombre: str(f.NombreTransaccion) },
        observacion: str(f.Observacion) || undefined,
        lineas: [],
        totalPendiente: 0,
        valorTotal: 0,
      };
      porNumero.set(numero, pedido);
    }
    pedido.lineas.push(linea);
    pedido.totalPendiente += pendiente;
    pedido.valorTotal += linea.valorTotal;
  }

  return Array.from(porNumero.values());
}
