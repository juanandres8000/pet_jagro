/**
 * SCRIPT — ingesta del módulo de descuentos desde una máquina local.
 *
 * ══ CÓMO CORRERLO ═════════════════════════════════════════════════════════
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
 *        scripts/descuentos-ingest.ts --mes=2026-09
 *        [--desde=2026-01 --hasta=2026-09]   rango de meses, del más nuevo al más viejo
 *
 *   Para probar contra una base DESECHABLE (Docker) sin tocar producción:
 *     DATABASE_URL=postgres://…local…  TOKEN_DATABASE_URL=<la de .env.local>  node … --mes=2026-09
 *   El token de HGINet se lee de TOKEN_DATABASE_URL (si no, de DATABASE_URL) en
 *   una conexión de SÓLO LECTURA; las escrituras van a DATABASE_URL.
 *
 * ══ TOKEN ═════════════════════════════════════════════════════════════════
 * Igual que scripts/pyg-ingest-ventana.ts: NUNCA llama /Api/Autenticar (HGINet
 * admite un solo token vigente y se lo quitaría a producción). Lee el vigente de
 * hgi_token con un SELECT; si está vencido o HGINet lo rechaza, ABORTA.
 *
 * ══ SÓLO ESCRIBE LO SUYO ══════════════════════════════════════════════════
 * dd_linea, dd_venta_agregado, dd_ventana_control. Nada más.
 */

import postgres from 'postgres';
import { ingestarVentana } from '../lib/hgi/descuentos/ingest';
import { mesesHasta, ventanaDeMes } from '../lib/hgi/descuentos/refresh';
import type { HgiFetch } from '../lib/hgi/pygFetch';

const flags = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] ?? 'true');
}
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

function mesesPedidos(): string[] {
  const mes = flags.get('mes');
  if (mes) {
    if (!MES.test(mes)) throw new Error(`--mes debe ser YYYY-MM, llegó "${mes}"`);
    return [mes];
  }
  const desde = flags.get('desde');
  const hasta = flags.get('hasta');
  if (!desde || !hasta || !MES.test(desde) || !MES.test(hasta) || desde > hasta) {
    throw new Error('Usar --mes=YYYY-MM o --desde=YYYY-MM --hasta=YYYY-MM');
  }
  return mesesHasta(`${hasta}-01`, desde).reverse();
}

async function fetcherLocal(): Promise<{ traer: HgiFetch; cerrar: () => Promise<void> }> {
  const base = process.env.HGI_BASE_URL?.replace(/\/+$/, '');
  if (!base) throw new Error('Falta HGI_BASE_URL en el entorno');
  const url = process.env.TOKEN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const sql = postgres(url, { prepare: false, max: 1, connection: { default_transaction_read_only: true } });
  const [row] = (await sql`SELECT jwt, expires_at FROM hgi_token WHERE id = 1`) as unknown as Array<{ jwt: string; expires_at: Date | null }>;
  await sql.end();
  if (!row?.jwt || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new Error('No hay token de HGINet vigente en hgi_token. Esperar a que la app lo renueve (no se autentica desde local).');
  }
  const jwt = row.jwt;
  const traer: HgiFetch = async <T,>(recurso: string, metodo: string, params: Record<string, string>, opts: { timeoutMs: number }) => {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${base}/Api/${recurso}/${metodo}/?${qs}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const body = await res.text();
    if (res.status === 401 || (res.status === 400 && body.trim() === '')) {
      throw new Error('HGINet rechazó el token (vencido). Abortando sin autenticar.');
    }
    if (!res.ok) throw new Error(`HGINet ${res.status} en ${recurso}/${metodo}: ${body.slice(0, 200)}`);
    return JSON.parse(body) as T;
  };
  return { traer, cerrar: async () => {} };
}

async function main() {
  const meses = mesesPedidos();
  const { traer } = await fetcherLocal();
  let fallos = 0;
  for (const mes of meses) {
    try {
      const r = await ingestarVentana(ventanaDeMes(mes), traer);
      console.log(
        `${mes} ok · ventas ${r.lineasVenta} líneas · ${r.docsPrecioCero} facturas con precio cero · ` +
          `compras ${r.lineasCompra} · guardadas ${r.guardadas} · sustituidas ${r.borradas} · ` +
          `fuera de ventana ${r.fueraVentana} · ${(r.duracionMs / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      fallos++;
      console.error(`${mes} ERROR: ${(err as Error).message}`);
      if (/token/i.test((err as Error).message)) break;
    }
  }
  process.exit(fallos ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
