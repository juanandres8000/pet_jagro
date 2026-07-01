import { hgiGet, HgiError, getValidToken } from './client';
import { mapPedidos, type HgiPedidoFila, type Pedido, type CatalogoInfo } from './mappers/pedidos';
import { readSnapshot } from './snapshotStore';
import type { ProductoDTO } from './mappers/productos';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Pedidos pendientes (core de picking).
 * Método real verificado: Api/Documentos/ObtenerPedidoPendienteReporte.
 * fecha_inicial antigua para capturar TODOS los pendientes. Una sola llamada.
 * El stock se cruza con el snapshot de catálogo ya cacheado en Neon (sin HGINet).
 */

const PARAMS = {
  codigo_transaccion: '*',
  documento: '*',
  codigo_tercero: '*',
  codigo_vendedor: '*',
  fecha_inicial: '2020-01-01',
};

/** Lee el snapshot de catálogo de Neon y arma el lookup por CodigoProducto. */
async function catalogoLookup(): Promise<Map<string, CatalogoInfo>> {
  const map = new Map<string, CatalogoInfo>();
  try {
    const snap = await readSnapshot<ProductoDTO>('catalog');
    if (snap) {
      for (const p of snap.data) {
        map.set(p.id, {
          descripcion: p.name,
          stockPorBodega: p.stockPorBodega,
          stockTotal: p.stock,
        });
      }
    }
  } catch {
    /* sin catálogo: las líneas quedan con stock null (no rompe pedidos) */
  }
  return map;
}

export async function buildPedidosSnapshot(): Promise<BuildResult<Pedido>> {
  await getValidToken(); // prime del token cacheado

  // Reporte de pedidos (HGINet) + catálogo (Neon) en paralelo.
  const [raw, catalogo] = await Promise.all([
    hgiGet<HgiPedidoFila[]>('Documentos', 'ObtenerPedidoPendienteReporte', PARAMS),
    catalogoLookup(),
  ]);

  const filas = Array.isArray(raw) ? raw.length : 0;
  const pedidos = mapPedidos(raw, catalogo);
  const lineas = pedidos.reduce((s, p) => s + p.lineas.length, 0);

  return {
    data: pedidos,
    sourceCounts: {
      filas, // filas planas devueltas por HGINet
      pedidos: pedidos.length, // pedidos con líneas pendientes
      lineas, // líneas pendientes (SaldoFinal>0)
      catalogoDisponible: catalogo.size > 0,
    },
  };
}

// Re-export para tipado del error en la route si hiciera falta.
export { HgiError };
