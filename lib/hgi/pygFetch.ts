import { hgiGet } from './client';

/**
 * Fetcher inyectable para los builders del P&G.
 *
 * En Vercel el único camino es `hgiGet` (lib/hgi/client.ts): resuelve el token
 * por el flujo compartido memoria → hgi_token → /Api/Autenticar y maneja el
 * reintento por token caducado. `hgiFetchPorDefecto` es exactamente eso.
 *
 * POR QUÉ ES INYECTABLE: `hgiGetInternal` abre con `getConfig()`, que valida las
 * CINCO variables HGI (usuario, clave, cod_compania, cod_empresa, base_url) sólo
 * para leer `baseUrl` — aunque el token esté cacheado y no haya que autenticar.
 * HGI_USUARIO y HGI_CLAVE viven únicamente en Vercel, así que cualquier script
 * local muere ahí. Los scripts de `scripts/` inyectan un fetcher que lee el
 * token vigente de `hgi_token` y hace el GET directo, sin autenticar nunca.
 */
export type HgiFetch = <T>(
  recurso: string,
  metodo: string,
  params: Record<string, string>,
  opts: { timeoutMs: number },
) => Promise<T>;

export const hgiFetchPorDefecto: HgiFetch = (recurso, metodo, params, opts) =>
  hgiGet(recurso, metodo, params, opts);
