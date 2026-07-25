import { hgiGet, HgiError, getValidToken } from './client';
import { mapTerceros, type HgiTercero, type Cliente } from './mappers/terceros';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Clientes (Terceros de HGINet).
 * Método real verificado: **Api/Terceros/Obtener**. Una sola llamada (nunca por
 * tercero). Usa hgiGet (token cacheado).
 *
 * ObtenerLista NO es un método equivalente y NO se usa como fallback.
 * El comentario anterior decía "también responde ObtenerLista" y era falso en lo
 * que importa: responde, y devuelve los 6.160 terceros, pero SIN
 * CodigoTipoTercero. Como el filtro de abajo se queda sólo con los tipos 1 y 7,
 * el fallback producía CERO clientes sin lanzar ninguna excepción.
 * Eso pasó en producción el 2026-07-25 03:50Z: Obtener falló, entró el fallback,
 * el build devolvió data vacía y se escribió encima del snapshot de 4.001 filas.
 * La vista de Clientes quedó vacía ~19 min.
 * Si Obtener falla, esto debe fallar RUIDOSAMENTE para que el serve-stale sirva
 * el snapshot anterior. Un fallback que devuelve data inservible es peor que un
 * error.
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

// Un solo método. Ver la nota de arriba sobre por qué ObtenerLista no entra.
const METODO = 'Obtener';

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
  let motivo: string;
  try {
    const r = await hgiGet<HgiTercero[]>('Terceros', METODO, PARAMS);
    if (Array.isArray(r) && r.length > 0) return { raw: r, source: METODO };
    motivo = `Terceros/${METODO} devolvió ${Array.isArray(r) ? 'array vacío' : 'respuesta no-array'}`;
  } catch (err) {
    motivo = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
  }
  // Se lanza sin intentar alternativas: el read-through degrada (serve-stale) y
  // la vista sigue con el snapshot bueno. Fallar aquí es el comportamiento
  // correcto, no una limitación.
  console.error(`[clientes] Terceros/${METODO} no devolvió datos usables: ${motivo}`);
  throw new Error(motivo);
}

export async function buildClientsSnapshot(): Promise<BuildResult<Cliente>> {
  await getValidToken(); // prime del token (cacheado), no re-autentica manualmente

  // Terceros + tipos de tercero EN PARALELO.
  const [terceros, tipos] = await Promise.all([fetchTerceros(), fetchTiposTercero()]);

  // Solo clientes reales (tipo 1 + 7) viajan al frontend.
  const clientes = mapTerceros(terceros.raw, tipos).filter((c) => TIPOS_CLIENTE.includes(c.codigoTipoTercero));

  // Que lleguen terceros y NINGUNO clasifique es un fallo de la fuente, no un
  // resultado legítimo: significa que CodigoTipoTercero no vino usable. Se lanza
  // para que el serve-stale sirva el snapshot anterior. El guard de
  // writeSnapshot ya impediría el daño, pero fallar aquí da el diagnóstico en el
  // log en vez de un "0 filas" mudo.
  if (terceros.raw.length > 0 && clientes.length === 0) {
    const msg =
      `Terceros/${METODO} devolvió ${terceros.raw.length} terceros pero ninguno de tipo ` +
      `${TIPOS_CLIENTE.join('/')}: CodigoTipoTercero no vino usable`;
    console.error(`[clientes] ${msg}`);
    throw new Error(msg);
  }

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
