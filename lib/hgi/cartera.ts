import { hgiGet, HgiError, getValidToken } from './client';
import { aggregateCartera, type HgiCarteraDoc, type CarteraCliente } from './mappers/cartera';
import { readSnapshot } from './snapshotStore';
import type { Cliente, HgiTercero } from './mappers/terceros';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Cartera (aging) contra HGINet.
 * Método real verificado: Api/Cartera/Obtener con anyo=<año>&periodo=*&resto=*.
 * NUNCA anyo=* (global): devuelve objeto/timeout (~60s). Con anyo fijo del año
 * en curso, HGINet retorna TODA la cartera abierta al corte (docs originales de
 * años anteriores vienen con Edad alta) — validado en ~32k documentos.
 *
 * La llamada es lenta (~22s) → timeout ampliado. Una sola llamada; si el año en
 * curso viene vacío (p.ej. inicio de año sin periodos), se cae al año anterior.
 */

const CARTERA_TIMEOUT_MS = 60_000;

const paramsAnyo = (anyo: number) => ({
  anyo: String(anyo),
  periodo: '*',
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '*',
  grupo: '*',
  codigo_clase: '*',
});

async function fetchCartera(anyo: number): Promise<HgiCarteraDoc[]> {
  const raw = await hgiGet<HgiCarteraDoc[]>('Cartera', 'Obtener', paramsAnyo(anyo), {
    timeoutMs: CARTERA_TIMEOUT_MS,
  });
  return Array.isArray(raw) ? raw : [];
}

/** Lee el snapshot de clients de Neon y arma el lookup CodigoTercero → nombre. */
async function nombresLookup(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const snap = await readSnapshot<Cliente>('clients');
    if (snap) for (const c of snap.data) map.set(c.id, c.nombre);
  } catch {
    /* sin clients: los top deudores muestran el código de tercero */
  }
  return map;
}

/**
 * Resuelve nombres de terceros que NO están en el snapshot de clients (que está
 * filtrado a tipos 1/7). El snapshot de clients omite proveedores/otros (p.ej.
 * distribuidores tipo 3) que sí pueden ser top deudores. Llamada puntual por
 * código a Api/Terceros/Obtener (filtra exacto por numero_identificacion, ~1s).
 * Solo se invoca para los ≤10 top deudores sin match, en paralelo.
 */
async function resolverNombresFaltantes(codigos: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const base = { codigo_auxiliar: '*', codigo_estado: '*', tipo_tercero: '*', codigo_ciudad: '*', codigo_vendedor: '*' };
  await Promise.all(
    codigos.map(async (cod) => {
      try {
        const raw = await hgiGet<HgiTercero[]>(
          'Terceros',
          'Obtener',
          { numero_identificacion: cod, ...base },
          { timeoutMs: 20_000 },
        );
        const t = Array.isArray(raw)
          ? raw.find((x) => String(x?.NumeroIdentificacion ?? '').trim() === cod) ?? raw[0]
          : null;
        const nombre = t ? String(t.Nombre ?? '').trim() || String(t.NombreComercial ?? '').trim() : '';
        if (nombre) map.set(cod, nombre);
      } catch {
        /* si falla, queda el fallback "Tercero {codigo}" en el builder */
      }
    }),
  );
  return map;
}

export async function buildCarteraSnapshot(): Promise<BuildResult<CarteraCliente>> {
  await getValidToken(); // prime del token cacheado

  const anyoActual = new Date().getFullYear();
  let anyoUsado = anyoActual;
  let raw = await fetchCartera(anyoActual);
  if (raw.length === 0) {
    // Año en curso sin datos → cartera abierta del año anterior.
    anyoUsado = anyoActual - 1;
    raw = await fetchCartera(anyoUsado);
  }

  const nombres = await nombresLookup();
  const { clientes, resumen } = aggregateCartera(raw, nombres);

  // Top deudores sin match en clients (tipos 1/7): resolver por llamada puntual;
  // fallback final "Tercero {codigo}".
  const faltantes = resumen.topDeudores.filter((d) => !nombres.has(d.codigoTercero)).map((d) => d.codigoTercero);
  if (faltantes.length) {
    const extra = await resolverNombresFaltantes(faltantes);
    resumen.topDeudores = resumen.topDeudores.map((d) =>
      nombres.has(d.codigoTercero)
        ? d
        : { ...d, nombre: extra.get(d.codigoTercero) ?? `Tercero ${d.codigoTercero}` },
    );
  }

  return {
    data: clientes, // agregado por tercero (liviano)
    sourceCounts: {
      ...resumen, // el resumen de aging viaja en sourceCounts (lo sirve el endpoint)
      fuente: 'Api/Cartera/Obtener',
      anyoConsultado: anyoUsado,
      docsCrudos: raw.length,
    },
  };
}

export { HgiError };
