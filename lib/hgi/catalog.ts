import { hgiGet, HgiError, getValidToken } from './client';
import { mapProductos, type HgiProducto, type ProductoDTO } from './mappers/productos';
import { buildInventarioMap, type HgiSaldo, type SaldoProducto } from './mappers/inventario';
import type { BuildResult } from './readThrough';

/**
 * Construcción del catálogo cruzado (Productos + stock de Inventario) contra HGINet.
 * Esta es la operación cara (~12s). El read-through (route) la invoca solo cuando
 * el snapshot vence. Usa hgiGet (token cacheado); no re-autentica manualmente.
 */

interface InventarioResult {
  map: Map<string, SaldoProducto>;
  source: string | null;
  error: string | null;
  count: number; // nº de filas Saldo crudas
}

/**
 * Trae el inventario completo en UNA llamada (nunca por producto).
 * Método real verificado: ObtenerInventario (el manual decía Obtener/
 * ObtenerSaldoInventario, ambos 404; se dejan como fallback).
 * Degrada sin lanzar: ante fallo devuelve mapa vacío + error, para no tumbar el catálogo.
 */
async function fetchInventario(): Promise<InventarioResult> {
  const params = { codigo_producto: '*', codigo_bodega: '*', codigo_lote: '*' };
  const metodos = ['ObtenerInventario', 'ObtenerSaldoInventario', 'Obtener'];
  let lastError = 'Inventario sin datos';

  for (const metodo of metodos) {
    try {
      const raw = await hgiGet<HgiSaldo[]>('Inventario', metodo, params);
      if (Array.isArray(raw) && raw.length > 0) {
        return { map: buildInventarioMap(raw), source: metodo, error: null, count: raw.length };
      }
      lastError = `Inventario/${metodo} devolvió ${Array.isArray(raw) ? 'array vacío' : 'respuesta no-array'}`;
    } catch (err) {
      lastError = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    }
  }
  return { map: new Map(), source: null, error: lastError, count: 0 };
}

/**
 * Reconstruye el catálogo cruzado. Productos e Inventario se piden EN PARALELO.
 * Devuelve el Product[] (exacto al que consume la vista) + metadata de fuentes.
 */
export async function buildCatalogSnapshot(): Promise<BuildResult<ProductoDTO>> {
  // Prime del token: una sola autenticación para que las llamadas paralelas
  // reusen la caché L1 y no compitan por el candado de token único.
  await getValidToken();

  const [productosRaw, inventario] = await Promise.all([
    hgiGet<HgiProducto[]>('Productos', 'Obtener', { codigo_producto: '*', incluir_foto: false }),
    fetchInventario(),
  ]);

  const products = mapProductos(productosRaw, { listaPrecio: 1, soloVigentes: true }, inventario.map);

  return {
    data: products,
    sourceCounts: {
      productos: Array.isArray(productosRaw) ? productosRaw.length : products.length,
      saldos: inventario.count,
      inventario: {
        disponible: inventario.error === null,
        fuente: inventario.source,
        aviso: inventario.error ? `Inventario no disponible (${inventario.error}); stock en 0.` : null,
      },
    },
  };
}
