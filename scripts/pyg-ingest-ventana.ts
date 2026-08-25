/**
 * SCRIPT ONE-OFF — ingesta una ventana de movimiento contable del P&G.
 *
 * ══ CÓMO CORRERLO ═════════════════════════════════════════════════════════
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
 *        scripts/pyg-ingest-ventana.ts --desde=2026-06-01 --hasta=2026-06-30
 *        [--plan]        también refresca pyg_cuenta desde PlanContable/ObtenerPCGA
 *        [--mes=2026-06] atajo: expande al mes completo, ignora desde/hasta
 *
 * ══ TOKEN: POR QUÉ ESTE SCRIPT NO USA hgiGet ══════════════════════════════
 *
 * `hgiGetInternal` abre con `getConfig()`, que valida las CINCO variables HGI
 * —usuario, clave, cod_compania, cod_empresa, base_url— sólo para leer `baseUrl`,
 * aunque el token esté cacheado y no haya nada que autenticar. HGI_USUARIO y
 * HGI_CLAVE viven ÚNICAMENTE en Vercel, así que en local ese camino muere con
 * "Falta variable de entorno HGI para usuario" antes de tocar la red.
 *
 * Por eso aquí se inyecta un fetcher que lee el token vigente de `hgi_token` con
 * UN SELECT y hace el GET directo. NUNCA llama /Api/Autenticar: HGINet sólo
 * admite un token vigente por usuario y autenticar desde una máquina de
 * desarrollo le arrebataría el token a producción. Si el token está vencido o
 * HGINet lo rechaza (401, o 400 con cuerpo vacío), el script ABORTA y lo dice.
 *
 * EN VERCEL ESTO NO APLICA: el código de producción (lib/hgi/pygIngest.ts con su
 * fetcher por defecto) usa `hgiGet` y el flujo normal de token. Este rodeo es
 * exclusivo de la ejecución local.
 *
 * ══ SÓLO ESCRIBE LO SUYO ══════════════════════════════════════════════════
 * Toca pyg_movimiento, pyg_ventana_control y —con --plan— pyg_cuenta. No toca
 * ninguna tabla de Gerencial, Cartera, Inventario, Clientes ni Catálogo.
 */

import postgres from 'postgres';
import { pygIngest, type Ventana } from '../lib/hgi/pygIngest';
import { refreshPlanCuentas, readResumenPlan } from '../lib/hgi/pygCuentaStore';
import type { HgiFetch } from '../lib/hgi/pygFetch';

// ---------------------------------------------------------------- CLI ------

const flags = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] ?? 'true');
}

/** Último día del mes 'YYYY-MM', en calendario (no depende de la zona horaria). */
function finDeMes(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${mes}-${String(ultimo).padStart(2, '0')}`;
}

function ventanaDeFlags(): Ventana {
  const mes = flags.get('mes');
  if (mes) {
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error(`--mes debe ser YYYY-MM, llegó "${mes}"`);
    return { desde: `${mes}-01`, hasta: finDeMes(mes) };
  }
  const desde = flags.get('desde');
  const hasta = flags.get('hasta');
  if (!desde || !hasta) throw new Error('Faltan --desde=YYYY-MM-DD y --hasta=YYYY-MM-DD (o --mes=YYYY-MM)');
  for (const [k, v] of [['desde', desde], ['hasta', hasta]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${k} debe ser YYYY-MM-DD, llegó "${v}"`);
  }
  if (desde > hasta) throw new Error(`--desde (${desde}) es posterior a --hasta (${hasta})`);
  return { desde, hasta };
}

// ------------------------------------------------- fetcher local (token) ---

let jwtCache: string | null = null;

/** Lee el token vigente de hgi_token con UN SELECT. No escribe, no autentica. */
async function tokenVigente(): Promise<string> {
  if (jwtCache) return jwtCache;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    const rows = (await sql`SELECT jwt, expires_at FROM hgi_token WHERE id = 1`) as unknown as Array<{
      jwt: string | null;
      expires_at: string | Date | null;
    }>;
    const row = rows[0];
    if (!row?.jwt || !row.expires_at) throw new Error('No hay token en hgi_token. Abortado: este script no autentica.');
    const expira = new Date(row.expires_at);
    const restanMs = expira.getTime() - Date.now();
    if (restanMs <= 0) {
      throw new Error(
        `El token de hgi_token venció (${expira.toISOString()}). Abortado: este script no re-autentica — ` +
          'esperá a que el cron de producción lo renueve.',
      );
    }
    console.log(`[token] reusado de hgi_token · vence ${expira.toISOString()} (${Math.round(restanMs / 60_000)} min)`);
    jwtCache = row.jwt;
    return jwtCache;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const fetcherLocal: HgiFetch = async (recurso, metodo, params, opts) => {
  const jwt = await tokenVigente();
  const base = process.env.HGI_BASE_URL;
  if (!base) throw new Error('Falta HGI_BASE_URL');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
  // Ruta case-sensitive: /Api/ con A mayúscula.
  const url = `${base.replace(/\/+$/, '')}/Api/${recurso}/${metodo}/?${qs}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}` },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      throw new Error('HGINet devolvió 401: el token fue rechazado. Abortado, este script no re-autentica.');
    }
    const raw = await res.text();
    if (res.status === 400 && raw.trim() === '') {
      throw new Error('HGINet devolvió 400 con cuerpo vacío (token caducado). Abortado, este script no re-autentica.');
    }
    if (!res.ok) throw new Error(`HGINet ${recurso}/${metodo} devolvió HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return JSON.parse(raw) as never;
  } finally {
    clearTimeout(timer);
  }
};

// -------------------------------------------------------------- main ------

const fmt = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });

async function main() {
  if (flags.get('plan') === 'true') {
    console.log('Refrescando pyg_cuenta desde PlanContable/ObtenerPCGA …');
    const r = await refreshPlanCuentas(fetcherLocal);
    if (r.rechazadoPorGuard) {
      console.error(`  RECHAZADO por el guard de ratio (existentes: ${r.existentes}). Plan anterior preservado.`);
      process.exit(1);
    }
    const resumen = await readResumenPlan();
    console.log(`  ${r.filas} cuentas · ${r.hojas} hojas · por nivel ${JSON.stringify(resumen.porNivel)}\n`);
  }

  const ventana = ventanaDeFlags();
  console.log(`Ingestando ventana [${ventana.desde} … ${ventana.hasta}] …`);
  const r = await pygIngest(ventana, fetcherLocal);

  console.log(`  estado            ${r.estado}`);
  console.log(`  documentos        ${fmt(r.documentos)}`);
  console.log(`  líneas guardadas  ${fmt(r.lineas)}`);
  console.log(`  líneas pseudo     ${fmt(r.lineasPseudo)} (descartadas: IdComprobante='0')`);
  console.log(`  fuera de ventana  ${fmt(r.lineasFueraVentana)}`);
  console.log(`  descartadas       ${fmt(r.lineasDescartadas)} (sin Id o sin cuenta)`);
  console.log(`  débitos           ${fmt(r.debitos)}`);
  console.log(`  créditos          ${fmt(r.creditos)}`);
  console.log(`  cuadra            ${r.cuadra}`);
  console.log(`  borradas          ${fmt(r.borradas)} (sustitución de la misma ventana)`);
  console.log(`  duración          ${(r.duracionMs / 1000).toFixed(1)} s`);
  const pico = process.memoryUsage().rss;
  console.log(`  pico RSS          ${(pico / 1024 / 1024).toFixed(0)} MB`);
  process.exit(0);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
