import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildCatalogSnapshot } from '@/lib/hgi/catalog';
import { buildClientsSnapshot } from '@/lib/hgi/clientes';
import { buildPedidosSnapshot } from '@/lib/hgi/pedidos';
import { buildCarteraSnapshot } from '@/lib/hgi/cartera';
import { buildVentasSnapshot } from '@/lib/hgi/ventas';
import { buildRecaudoSnapshot } from '@/lib/hgi/recaudo';
import { buildClasesSnapshot } from '@/lib/hgi/clases';
import { refreshVentasMensual } from '@/lib/hgi/ventasMensual';
import {
  refreshPygCuentas,
  refreshPygBackfill,
  refreshPygDia,
  refreshPygCierres,
} from '@/lib/hgi/pygRefresh';
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
  clases: buildClasesSnapshot,
};

// `clases` no tiene cron: se reconstruye por TTL en /api/clases (60 min) o a
// mano por esta ruta. Su build es una sola llamada de ~32s, no necesita prewarm.
const ALL: Dataset[] = ['catalog', 'clients', 'pedidos', 'cartera', 'ventas', 'recaudo', 'clases'];

/**
 * `ventas_mensual` no es un dataset de hgi_snapshot: escribe en su propia tabla,
 * una fila por mes, y construye UN mes por corrida (ver lib/hgi/ventasMensual.ts).
 * Por eso va por rama aparte y no por el mapa BUILDERS, que asume
 * build() -> writeSnapshot(dataset, ...).
 *   ?dataset=ventas_mensual[&mes=YYYY-MM]   ← `mes` fuerza uno concreto
 */
const DATASET_MENSUAL = 'ventas_mensual';

/**
 * Datasets del P&G. Como `ventas_mensual`, no son datasets de hgi_snapshot:
 * escriben en pyg_movimiento / pyg_ventana_control / pyg_cuenta y hacen UNA
 * unidad de trabajo por corrida, con el cursor en tabla. Por eso van por rama
 * aparte y no por el mapa BUILDERS, que asume build() -> writeSnapshot().
 *
 *   ?dataset=pyg_cuentas                    plan PCGA (diario)
 *   ?dataset=pyg_backfill[&mes=YYYY-MM]     una ventana MENSUAL por invocación
 *   ?dataset=pyg_dia                        ventanas de un día, últimos 7
 *   ?dataset=pyg_cierres                    último día de meses sin costo valorizado
 */
const DATASETS_PYG = ['pyg_cuentas', 'pyg_backfill', 'pyg_dia', 'pyg_cierres'] as const;
type DatasetPyg = (typeof DATASETS_PYG)[number];

/** Despacha el dataset del P&G que corresponda. `maxDuration` acota el presupuesto. */
async function ejecutarPyg(dataset: DatasetPyg, mes?: string): Promise<Record<string, unknown>> {
  switch (dataset) {
    case 'pyg_cuentas':
      return { ...(await refreshPygCuentas()) };
    case 'pyg_backfill':
      return { ...(await refreshPygBackfill(mes)) };
    case 'pyg_dia':
      return { ...(await refreshPygDia(maxDuration)) };
    case 'pyg_cierres':
      return { ...(await refreshPygCierres(maxDuration)) };
  }
}

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

  if (param && (DATASETS_PYG as readonly string[]).includes(param)) {
    const mesParam = url.searchParams.get('mes') ?? undefined;
    if (mesParam && !/^\d{4}-\d{2}$/.test(mesParam)) {
      return NextResponse.json({ ok: false, mensaje: 'Parámetro "mes" debe ser YYYY-MM' }, { status: 400 });
    }
    try {
      const r = await ejecutarPyg(param as DatasetPyg, mesParam);
      return NextResponse.json({ ok: true, dataset: param, ...r });
    } catch (err) {
      const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
      console.error(`[refresh] dataset "${param}" falló: ${mensaje}`);
      return NextResponse.json({ ok: false, dataset: param, mensaje }, { status: 502 });
    }
  }

  const datasets: Dataset[] = param && ALL.includes(param as Dataset) ? [param as Dataset] : ALL;

  const results: Record<string, unknown> = {};
  let anyError = false;

  for (const dataset of datasets) {
    try {
      const build = await BUILDERS[dataset]();
      const builtAt = await writeSnapshot(dataset, build.data, build.sourceCounts);
      if (builtAt === null) {
        // Guard de tamaño: no se escribió nada y el snapshot anterior sigue vivo.
        // Cuenta como error de la corrida para que el 502 lo haga visible.
        anyError = true;
        const mensaje =
          `build devolvió ${build.data.length} filas y no pasó el guard de tamaño; ` +
          'snapshot anterior preservado (no se sobreescribió)';
        console.error(`[refresh] dataset "${dataset}": ${mensaje}`);
        results[dataset] = { ok: false, mensaje, rechazadoPorGuard: true };
      } else {
        results[dataset] = { ok: true, built_at: builtAt.toISOString(), count: build.data.length };
      }
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
