import { NextResponse } from 'next/server';
import { hgiGet, HgiError } from '@/lib/hgi/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * RUTA TEMPORAL DE EXPLORACIÓN — borrar cuando termine el sondeo de P&G.
 *
 * Existe porque las credenciales de HGINet viven sólo en Vercel y re-autenticar
 * desde local invalidaría el token de producción (HGINet permite uno vigente por
 * usuario). Este sondeo corre en el lambda de prod, que reusa el token cacheado.
 *
 * No devuelve payloads completos: sólo forma (claves, tipos, conteos) y una
 * muestra recortada, para poder decidir el diseño del módulo sin volcar miles de
 * filas ni datos contables innecesarios al cliente.
 *
 * Protegida con HGI_EXPLORE_SECRET (variable nueva y temporal, no reutiliza los
 * secretos de cron/refresh).
 */

interface Sonda {
  recurso: string;
  metodo: string;
  /** ORDEN EXACTO: el routing de WebAPI es por firma; otro orden da 404. */
  params: Record<string, string>;
  nota?: string;
}

const EMPRESA = process.env.HGI_COD_EMPRESA ?? '';

/** Claves + tipo de cada campo, para ver la forma sin volcar la fila entera. */
function forma(o: unknown): Record<string, string> {
  if (!o || typeof o !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v;
  }
  return out;
}

/** Recorta strings largos para que la muestra sea legible. */
function recortar(o: unknown): unknown {
  if (Array.isArray(o)) return o.slice(0, 2).map(recortar);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = typeof v === 'string' && v.length > 60 ? `${v.slice(0, 60)}…` : recortar(v);
    }
    return out;
  }
  return o;
}

async function sondear(s: Sonda) {
  const t0 = Date.now();
  try {
    const raw = await hgiGet<unknown>(s.recurso, s.metodo, s.params, { timeoutMs: 120_000 });
    const ms = Date.now() - t0;
    const esArray = Array.isArray(raw);
    return {
      ruta: `${s.recurso}/${s.metodo}`,
      nota: s.nota,
      params: s.params,
      ok: true,
      ms,
      tipo: esArray ? 'array' : typeof raw,
      filas: esArray ? (raw as unknown[]).length : null,
      formaFila: esArray ? forma((raw as unknown[])[0]) : forma(raw),
      muestra: recortar(esArray ? (raw as unknown[])[0] : raw),
    };
  } catch (err) {
    return {
      ruta: `${s.recurso}/${s.metodo}`,
      nota: s.nota,
      params: s.params,
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message,
    };
  }
}

export async function GET(req: Request) {
  const secret = process.env.HGI_EXPLORE_SECRET;
  if (!secret) return NextResponse.json({ ok: false, mensaje: 'HGI_EXPLORE_SECRET no configurado' }, { status: 500 });
  if (req.headers.get('x-hgi-explore-secret') !== secret) {
    return NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });
  }

  const grupo = new URL(req.url).searchParams.get('grupo') ?? 'todo';
  const resultados: unknown[] = [];

  // ---- Plan contable: jerarquía de cuentas ----
  if (grupo === 'todo' || grupo === 'plan') {
    const planes: Sonda[] = [
      { recurso: 'PlanContable', metodo: 'ObtenerPlanContableNIIF', params: { codigo: '*' } },
      { recurso: 'PlanContable', metodo: 'ObtenerPlanContableNIIF', params: {}, nota: 'sin params' },
      { recurso: 'PlanContable', metodo: 'ObtenerPlanContablePCGA', params: { codigo: '*' } },
      { recurso: 'PlanContable', metodo: 'Obtener', params: { codigo: '*' }, nota: 'variante genérica' },
      { recurso: 'PlanContableNIIF', metodo: 'Obtener', params: { codigo: '*' }, nota: 'variante de recurso' },
    ];
    for (const s of planes) resultados.push(await sondear(s));
  }

  // ---- Documentos contables: movimiento con débito/crédito ----
  if (grupo === 'todo' || grupo === 'docs') {
    // ORDEN EXACTO documentado: empresa, comprobante, documento, fecha_inicial, fecha_final.
    const rango = (desde: string, hasta: string) => ({
      empresa: EMPRESA,
      comprobante: '*',
      documento: '*',
      fecha_inicial: desde,
      fecha_final: hasta,
    });
    const docs: Sonda[] = [
      { recurso: 'DocumentosContables', metodo: 'Obtener', params: rango('2026-06-01', '2026-06-01'), nota: '1 día (latencia base)' },
      { recurso: 'DocumentosContables', metodo: 'Obtener', params: rango('2026-06-01', '2026-06-05'), nota: '5 días' },
      { recurso: 'DocumentosContables', metodo: 'Obtener', params: rango('2026-06-01', '2026-06-30'), nota: 'mes cerrado completo' },
    ];
    for (const s of docs) resultados.push(await sondear(s));
  }

  // ---- Variantes de ruta, sólo si la principal falló ----
  if (grupo === 'variantes') {
    const rango = {
      empresa: EMPRESA,
      comprobante: '*',
      documento: '*',
      fecha_inicial: '2026-06-01',
      fecha_final: '2026-06-01',
    };
    const vars: Sonda[] = [
      { recurso: 'DocumentosContables', metodo: 'ObtenerLista', params: rango },
      { recurso: 'DocumentoContable', metodo: 'Obtener', params: rango, nota: 'singular' },
      { recurso: 'Contabilidad', metodo: 'ObtenerDocumentos', params: rango },
      { recurso: 'DocumentosContables', metodo: 'ObtenerDetalleReporte', params: rango },
      { recurso: 'DocumentosContables', metodo: 'Obtener', params: { ...rango, empresa: '*' }, nota: 'empresa=*' },
    ];
    for (const s of vars) resultados.push(await sondear(s));
  }

  return NextResponse.json({ ok: true, empresaUsada: EMPRESA || '(HGI_COD_EMPRESA vacío)', grupo, resultados });
}
