import { hgiGet, HgiError, getValidToken } from './client';
import { mapTerceros, type HgiTercero, type Cliente } from './mappers/terceros';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Clientes (Terceros de HGINet).
 * Método real verificado: Api/Terceros/Obtener (también responde ObtenerLista).
 * Una sola llamada (nunca por tercero). Usa hgiGet (token cacheado).
 *
 * FILTRO DE CLIENTES REALES: solo viajan al frontend los CodigoTipoTercero
 * 1 (CLIENTES GENERALES) y 7 (CLIENTES MOSTRADOR). Proveedores, empleados,
 * contratistas, pacientes, costos/gastos NO se exponen aquí — si otra vista los
 * necesita, será un dataset propio con su endpoint.
 */
export const TIPOS_CLIENTE = ['1', '7'];

const PARAMS = {
  numero_identificacion: '*',
  codigo_auxiliar: '*',
  codigo_estado: '*',
  tipo_tercero: '*',
  codigo_ciudad: '*',
  codigo_vendedor: '*',
};

const METODOS = ['Obtener', 'ObtenerLista'];

interface HgiTerceroTipo {
  Codigo?: string | number;
  Descripcion?: string;
}

/**
 * Trae el catálogo de tipos de tercero (configurable por empresa) y devuelve
 * Map<Codigo, Descripcion>. Método real verificado: Api/TercerosTipo/Obtener.
 * Degrada a mapa vacío si falla (los clientes se muestran igual, sin descripción).
 */
async function fetchTiposTercero(): Promise<Map<string, string>> {
  try {
    const raw = await hgiGet<HgiTerceroTipo[]>('TercerosTipo', 'Obtener', { codigo: '*' });
    const map = new Map<string, string>();
    if (Array.isArray(raw)) {
      for (const t of raw) {
        const cod = t?.Codigo === undefined || t?.Codigo === null ? '' : String(t.Codigo).trim();
        if (cod) map.set(cod, String(t.Descripcion ?? '').trim());
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Conteo por tipo con descripción resuelta, para clasificar clientes/proveedores/etc. */
function contarTipos(clientes: Cliente[], tipos: Map<string, string>): Record<string, { descripcion: string; count: number }> {
  const counts: Record<string, { descripcion: string; count: number }> = {};
  for (const c of clientes) {
    const k = c.codigoTipoTercero || '(vacío)';
    if (!counts[k]) counts[k] = { descripcion: tipos.get(k) ?? '(desconocido)', count: 0 };
    counts[k].count += 1;
  }
  return counts;
}

async function fetchTerceros(): Promise<{ raw: HgiTercero[]; source: string }> {
  let lastError = 'Terceros sin datos';
  for (const metodo of METODOS) {
    try {
      const r = await hgiGet<HgiTercero[]>('Terceros', metodo, PARAMS);
      if (Array.isArray(r) && r.length > 0) return { raw: r, source: metodo };
      lastError = `Terceros/${metodo} devolvió ${Array.isArray(r) ? 'array vacío' : 'respuesta no-array'}`;
    } catch (err) {
      lastError = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    }
  }
  // Si Terceros falla del todo, lanzamos: el read-through degrada (serve-stale)
  // o la route responde lista vacía + aviso, sin tumbar la vista.
  throw new Error(lastError);
}

export async function buildClientsSnapshot(): Promise<BuildResult<Cliente>> {
  await getValidToken(); // prime del token (cacheado), no re-autentica manualmente

  // Terceros + tipos de tercero EN PARALELO.
  const [terceros, tipos] = await Promise.all([fetchTerceros(), fetchTiposTercero()]);

  // Solo clientes reales (tipo 1 + 7) viajan al frontend.
  const clientes = mapTerceros(terceros.raw, tipos).filter((c) => TIPOS_CLIENTE.includes(c.codigoTipoTercero));

  return {
    data: clientes,
    sourceCounts: {
      terceros: terceros.raw.length, // total en HGINet (observabilidad)
      clientes: clientes.length, // los que se exponen (1+7)
      fuente: terceros.source,
      // Conteo por tipo, ya restringido a 1 y 7 (para el toggle de la vista).
      tiposCliente: contarTipos(clientes, tipos),
    },
  };
}
