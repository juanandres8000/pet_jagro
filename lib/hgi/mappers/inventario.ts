/**
 * Agregador de Inventario de HGINet (Api/Inventario/Obtener).
 *
 * El endpoint devuelve un array de Saldo: una fila por (producto, bodega, lote).
 * El stock total de un producto = suma de Cantidad sobre todas sus bodegas y lotes.
 * Guardamos además el desglose por bodega (útil para picking).
 */

export interface HgiSaldo {
  CodigoProducto?: string | number;
  CodigoBodega?: string | number;
  Lote?: string | number;
  Cantidad?: number | string;
  Costo?: number | string;
  VencimientoLote?: string;
  SKU?: string;
  EAN?: string;
  [key: string]: unknown; // tolerar campos extra
}

export interface SaldoProducto {
  /** Stock total = suma de Cantidad en todas las bodegas y lotes. */
  total: number;
  /** Desglose: { codigoBodega: cantidad sumada en esa bodega }. */
  porBodega: Record<string, number>;
}

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Construye Map<CodigoProducto, SaldoProducto> a partir del array crudo de Saldo.
 * Tolera array vacío/nulo (devuelve Map vacío) y filas sin producto.
 */
export function buildInventarioMap(raw: unknown): Map<string, SaldoProducto> {
  const map = new Map<string, SaldoProducto>();
  if (!Array.isArray(raw)) return map;

  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const saldo = s as HgiSaldo;
    const codigo = str(saldo.CodigoProducto);
    if (!codigo) continue;

    const cantidad = num(saldo.Cantidad);
    const bodega = str(saldo.CodigoBodega) || '(sin bodega)';

    const entry = map.get(codigo) ?? { total: 0, porBodega: {} };
    entry.total += cantidad;
    entry.porBodega[bodega] = (entry.porBodega[bodega] ?? 0) + cantidad;
    map.set(codigo, entry);
  }

  return map;
}
