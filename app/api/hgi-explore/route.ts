import { NextResponse } from 'next/server';
import { hgiGet, getValidToken } from '@/lib/hgi/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL — DIAGNÓSTICO de filas repetidas en Cartera/Obtener.
 * Borrar al terminar. SOLO LECTURA: no escribe en ningún snapshot.
 *
 * Pregunta a resolver: las 720 claves (transaccion-documento-tercero) repetidas
 * son filas distintas del ERP, o el mismo saldo contado varias veces (y entonces
 * totalAbierto está inflado).
 *
 * Trabaja sobre el payload CRUDO, sin pasar por el mapper, porque justamente lo
 * que hay que ver son los campos que el mapper no proyecta.
 */

const TIMEOUT_MS = 200_000;

type Fila = Record<string, unknown>;

/** Firma verificada de Cartera/Obtener, en ORDEN (ver lib/hgi/cartera.ts). */
const params = (anyo: string, periodo: string) => ({
  anyo,
  periodo,
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '*',
  grupo: '*',
  codigo_clase: '*',
});

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Misma clave que usaba la tabla de próximos vencimientos. */
const clave = (f: Fila) => `${str(f.Transaccion)}-${str(f.Documento)}-${str(f.CodigoTercero)}`;

/** Huella de TODOS los campos, para saber si dos filas son idénticas del todo. */
function huella(f: Fila): string {
  return Object.keys(f)
    .filter((k) => k !== '$type')
    .sort()
    .map((k) => `${k}=${str(f[k])}`)
    .join('|');
}

/** Suma de SaldoFinal>0, que es exactamente cómo se calcula totalAbierto. */
const totalAbiertoDe = (filas: Fila[]) =>
  filas.reduce((a, f) => (num(f.SaldoFinal) > 0 ? a + num(f.SaldoFinal) : a), 0);

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const anyo = sp.get('anyo') ?? '2026';
  const periodo = sp.get('periodo') ?? '*';
  const doc = sp.get('doc') ?? '196509';
  const tercero = sp.get('tercero') ?? '900323135';

  await getValidToken();

  const t0 = Date.now();
  const raw = await hgiGet<Fila[]>('Cartera', 'Obtener', params(anyo, periodo), { timeoutMs: TIMEOUT_MS });
  const ms = Date.now() - t0;
  const filas = Array.isArray(raw) ? raw : [];

  // Sólo cartera abierta, que es el universo de totalAbierto.
  const abiertas = filas.filter((f) => num(f.SaldoFinal) > 0);

  // ---- 1. Los registros COMPLETOS del caso identificado ----
  const caso = abiertas.filter((f) => str(f.Documento) === doc && str(f.CodigoTercero) === tercero);

  // ---- 2. Campos que difieren entre esas filas ----
  const camposCaso: Record<string, string[]> = {};
  if (caso.length > 1) {
    const keys = new Set<string>();
    for (const f of caso) for (const k of Object.keys(f)) keys.add(k);
    for (const k of [...keys].sort()) {
      const vals = caso.map((f) => str(f[k]));
      if (new Set(vals).size > 1) camposCaso[k] = vals;
    }
  }

  // ---- 3. Generalización sobre TODAS las claves repetidas ----
  const porClave = new Map<string, Fila[]>();
  for (const f of abiertas) {
    const k = clave(f);
    porClave.set(k, [...(porClave.get(k) ?? []), f]);
  }
  const repetidas = [...porClave].filter(([, v]) => v.length > 1);

  // Para cada campo: en cuántas claves repetidas ese campo discrimina.
  const todosLosCampos = new Set<string>();
  for (const f of abiertas) for (const k of Object.keys(f)) todosLosCampos.add(k);
  const discriminaEn: Record<string, number> = {};
  for (const k of todosLosCampos) discriminaEn[k] = 0;
  let clavesConFilasIdenticas = 0;
  let filasExtraIdenticas = 0;
  let saldoDeFilasIdenticasExtra = 0;

  for (const [, grupo] of repetidas) {
    for (const k of todosLosCampos) {
      if (new Set(grupo.map((f) => str(f[k]))).size > 1) discriminaEn[k] += 1;
    }
    // ¿alguna fila del grupo es idéntica a otra en TODOS los campos?
    const huellas = new Map<string, number>();
    for (const f of grupo) huellas.set(huella(f), (huellas.get(huella(f)) ?? 0) + 1);
    const extras = [...huellas].filter(([, n]) => n > 1);
    if (extras.length) {
      clavesConFilasIdenticas += 1;
      for (const [h, n] of extras) {
        filasExtraIdenticas += n - 1;
        const rep = grupo.find((f) => huella(f) === h)!;
        saldoDeFilasIdenticasExtra += num(rep.SaldoFinal) * (n - 1);
      }
    }
  }

  // ---- 4. ¿Cuánto de totalAbierto sería sobreconteo? ----
  const total = totalAbiertoDe(abiertas);
  const dedupPorHuella = new Map<string, Fila>();
  for (const f of abiertas) if (!dedupPorHuella.has(huella(f))) dedupPorHuella.set(huella(f), f);
  const totalDedupHuella = totalAbiertoDe([...dedupPorHuella.values()]);

  const dedupPorClave = new Map<string, Fila>();
  for (const f of abiertas) if (!dedupPorClave.has(clave(f))) dedupPorClave.set(clave(f), f);
  const totalDedupClave = totalAbiertoDe([...dedupPorClave.values()]);

  const camposQueDiscriminan = Object.entries(discriminaEn)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return NextResponse.json({
    ok: true,
    consulta: { anyo, periodo, ms, filasCrudas: filas.length, filasAbiertas: abiertas.length },

    caso: {
      documento: doc,
      tercero,
      encontradas: caso.length,
      registrosCompletos: caso,
      camposQueDifieren: camposCaso,
      todosIdenticos: caso.length > 1 && Object.keys(camposCaso).length === 0,
    },

    generalizacion: {
      clavesUnicas: porClave.size,
      clavesRepetidas: repetidas.length,
      filasExtraPorRepeticion: repetidas.reduce((a, [, v]) => a + v.length - 1, 0),
      camposQueDiscriminanEnAlgunaClave: Object.fromEntries(camposQueDiscriminan),
      clavesConFilasIdenticasEnTodo: clavesConFilasIdenticas,
      filasExtraIdenticasEnTodo: filasExtraIdenticas,
    },

    sobreconteo: {
      totalAbierto: Math.round(total),
      // Deduplicando sólo filas idénticas en TODOS los campos: ése es el
      // sobreconteo indiscutible, si existe.
      totalSinFilasIdenticas: Math.round(totalDedupHuella),
      sobreconteoPorFilasIdenticas: Math.round(total - totalDedupHuella),
      saldoDeFilasIdenticasExtra: Math.round(saldoDeFilasIdenticasExtra),
      // Deduplicando por clave (una fila por documento): cota superior, sólo
      // válida si las filas de una clave son el mismo saldo repetido.
      totalUnaFilaPorClave: Math.round(totalDedupClave),
      diferenciaSiUnaFilaPorClave: Math.round(total - totalDedupClave),
    },
  });
}
