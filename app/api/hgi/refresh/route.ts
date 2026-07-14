import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildCatalogSnapshot } from '@/lib/hgi/catalog';
import { buildClientsSnapshot } from '@/lib/hgi/clientes';
import { buildPedidosSnapshot } from '@/lib/hgi/pedidos';
import { buildCarteraSnapshot } from '@/lib/hgi/cartera';
import { writeSnapshot, type Dataset } from '@/lib/hgi/snapshotStore';
import type { BuildResult } from '@/lib/hgi/readThrough';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reconstruye contra HGINet (~12-22s por dataset; cartera hasta ~25s).
export const maxDuration = 60;

// Builders por dataset. Para refrescar uno: ?dataset=catalog|clients|pedidos|cartera.
const BUILDERS: Record<Dataset, () => Promise<BuildResult<unknown>>> = {
  catalog: buildCatalogSnapshot,
  clients: buildClientsSnapshot,
  pedidos: buildPedidosSnapshot,
  cartera: buildCarteraSnapshot,
};

const ALL: Dataset[] = ['catalog', 'clients', 'pedidos', 'cartera'];

/** Ejecuta el rebuild de los datasets pedidos (o todos) y guarda en Neon. */
async function runRefresh(req: Request): Promise<NextResponse> {
  const param = new URL(req.url).searchParams.get('dataset') as Dataset | null;
  const datasets: Dataset[] = param && ALL.includes(param) ? [param] : ALL;

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
 *   GET /api/hgi/refresh?dataset=catalog|clients|pedidos
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
 *   POST /api/hgi/refresh[?dataset=catalog|clients|pedidos]
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
