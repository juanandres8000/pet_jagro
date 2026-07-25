import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildCatalogSnapshot } from '@/lib/hgi/catalog';
import { buildClientsSnapshot } from '@/lib/hgi/clientes';
import { buildPedidosSnapshot } from '@/lib/hgi/pedidos';
import { buildCarteraSnapshot } from '@/lib/hgi/cartera';
import { buildVentasSnapshot } from '@/lib/hgi/ventas';
import { buildRecaudoSnapshot } from '@/lib/hgi/recaudo';
import { refreshVentasMensual } from '@/lib/hgi/ventasMensual';
import { writeSnapshot, type Dataset } from '@/lib/hgi/snapshotStore';
import type { BuildResult } from '@/lib/hgi/readThrough';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reconstruye contra HGINet. catalog/clients/pedidos ~12s, cartera ~25-40s,
// y ventas/recaudo paginan varias ventanas: son los que fijan el techo.
export const maxDuration = 300;

// Builders por dataset. Para refrescar uno:
// ?dataset=catalog|clients|pedidos|cartera|ventas|recaudo.
const BUILDERS: Record<Dataset, () => Promise<BuildResult<unknown>>> = {
  catalog: buildCatalogSnapshot,
  clients: buildClientsSnapshot,
  pedidos: buildPedidosSnapshot,
  cartera: buildCarteraSnapshot,
  ventas: buildVentasSnapshot,
  recaudo: buildRecaudoSnapshot,
};

const ALL: Dataset[] = ['catalog', 'clients', 'pedidos', 'cartera', 'ventas', 'recaudo'];

/**
 * `ventas_mensual` no es un dataset de hgi_snapshot: escribe en su propia tabla,
 * una fila por mes, y construye UN mes por corrida (ver lib/hgi/ventasMensual.ts).
 * Por eso va por rama aparte y no por el mapa BUILDERS, que asume
 * build() -> writeSnapshot(dataset, ...).
 *   ?dataset=ventas_mensual[&mes=YYYY-MM]   ← `mes` fuerza uno concreto
 */
const DATASET_MENSUAL = 'ventas_mensual';

/** Ejecuta el rebuild de los datasets pedidos (o todos) y guarda en Supabase. */
async function runRefresh(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const param = url.searchParams.get('dataset');

  if (param === DATASET_MENSUAL) {
    const mesParam = url.searchParams.get('mes') ?? undefined;
    if (mesParam && !/^\d{4}-\d{2}$/.test(mesParam)) {
      return NextResponse.json({ ok: false, mensaje: 'Parámetro "mes" debe ser YYYY-MM' }, { status: 400 });
    }
    try {
      const r = await refreshVentasMensual(mesParam);
      return NextResponse.json({ ok: true, dataset: DATASET_MENSUAL, ...r });
    } catch (err) {
      const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
      console.error(`[refresh] dataset "${DATASET_MENSUAL}" falló: ${mensaje}`);
      return NextResponse.json({ ok: false, dataset: DATASET_MENSUAL, mensaje }, { status: 502 });
    }
  }

  const datasets: Dataset[] = param && ALL.includes(param as Dataset) ? [param as Dataset] : ALL;

  const results: Record<string, unknown> = {};
  let anyError = false;

  for (const dataset of datasets) {
    try {
      const build = await BUILDERS[dataset]();
      const builtAt = await writeSnapshot(dataset, build.data, build.sourceCounts);
      results[dataset] = { ok: true, built_at: builtAt.toISOString(), count: build.data.length };
    } catch (err) {
      anyError = true;
      const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
      // El mensaje viaja en el body del 502 y Vercel NO loguea response bodies:
      // sin este console.error la causa del fallo del cron era invisible.
      console.error(`[refresh] dataset "${dataset}" falló: ${mensaje}`);
      results[dataset] = { ok: false, mensaje };
    }
  }

  return NextResponse.json({ ok: !anyError, datasets: results }, { status: anyError ? 502 : 200 });
}

const unauthorized = () => NextResponse.json({ ok: false, mensaje: 'No autorizado' }, { status: 401 });

/**
 * GET — disparo desde Vercel Cron.
 * Los crons no pueden mandar headers propios ni POST: Vercel adjunta
 * `Authorization: Bearer $CRON_SECRET` automáticamente. Se valida contra CRON_SECRET.
 *   GET /api/hgi/refresh?dataset=catalog|clients|pedidos|cartera|ventas|recaudo
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, mensaje: 'CRON_SECRET no configurado' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return unauthorized();
  }
  return runRefresh(req);
}

/**
 * POST — disparo MANUAL (curl/Postman) con header secreto.
 *   POST /api/hgi/refresh[?dataset=catalog|clients|pedidos|cartera|ventas|recaudo]
 *   header: x-hgi-refresh-secret: <HGI_REFRESH_SECRET>
 */
export async function POST(req: Request) {
  const secret = process.env.HGI_REFRESH_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, mensaje: 'HGI_REFRESH_SECRET no configurado' }, { status: 500 });
  }
  if (req.headers.get('x-hgi-refresh-secret') !== secret) {
    return unauthorized();
  }
  return runRefresh(req);
}
