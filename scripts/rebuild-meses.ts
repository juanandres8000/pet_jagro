/**
 * Reconstruye meses de hgi_ventas_mensual desde la terminal local, reanudable.
 *
 * ══ CÓMO CORRERLO ═════════════════════════════════════════════════════════
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/rebuild-meses.ts [--dry]
 *
 * Existe porque el backfill sólo corría como cron de Vercel (un mes por hora) y
 * en local `hgiGet` muere en `getConfig()`, que exige HGI_USUARIO/HGI_CLAVE —
 * sólo están en Vercel. Igual que scripts/pyg-ingest-ventana.ts, inyecta un
 * fetcher que lee el token vigente de `hgi_token` y NUNCA autentica: HGINet
 * admite un solo token por usuario y autenticar desde aquí se lo quitaría a
 * producción.
 *
 * No duplica lógica: por mes llama a las mismas `fetchRango` (ventanas de 5
 * días, concurrencia 2, pausa 400 ms: el ritmo del cron), `agregarMes` y
 * `writeMes` que usa el cron.
 *
 * Por mes: construye, verifica Σ por_proveedor = Σ por_zona = Σ clientes de
 * por_zona = venta neta del mes, y SÓLO entonces escribe. Si la verificación
 * falla, el mes se salta y queda intacto.
 *
 * Reanudable: salta los meses que ya tienen `por_proveedor` NOT NULL.
 * `--dry` construye y verifica sin escribir.
 */
import { getSql } from '../lib/pg';
import { fetchRango, hoyColombia } from '../lib/hgi/ventas';
import { agregarMes, rangoDeMes, mesDe } from '../lib/hgi/ventasMensual';
import { writeMes } from '../lib/hgi/ventasMensualStore';
import type { HgiFetch } from '../lib/hgi/pygFetch';

/** 2026-09 → 2025-01, del más reciente al más antiguo. 2024 no se toca. */
const DESDE = '2025-01';
const HASTA = '2026-09';
/** Respiro entre meses, además de la pausa entre ventanas de fetchRango. */
const PAUSA_ENTRE_MESES_MS = 5_000;
/** Tolerancia de la verificación, en pesos (sumas en coma flotante). */
const TOLERANCIA = 1;

const DRY = process.argv.includes('--dry');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
const ts = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

function meses(): string[] {
  const out: string[] = [];
  let [y, m] = HASTA.split('-').map(Number);
  for (;;) {
    const mes = `${y}-${String(m).padStart(2, '0')}`;
    if (mes < DESDE) break;
    out.push(mes);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

// ------------------------------------------------- fetcher local (token) ---

/**
 * El token se relee de hgi_token cada minuto, no se memoiza para toda la
 * corrida: el cron de producción puede renovarlo a mitad del backfill, y con un
 * solo token vigente por usuario el viejo deja de servir.
 */
let jwt: { valor: string; leido: number } | null = null;

async function tokenVigente(): Promise<string> {
  if (jwt && Date.now() - jwt.leido < 60_000) return jwt.valor;
  const rows = (await getSql()`SELECT jwt, expires_at FROM hgi_token WHERE id = 1`) as unknown as Array<{
    jwt: string | null;
    expires_at: string | Date | null;
  }>;
  const row = rows[0];
  if (!row?.jwt || !row.expires_at) throw new Error('No hay token en hgi_token. Este script no autentica.');
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new Error('El token de hgi_token venció. Este script no re-autentica: esperá a que el cron lo renueve.');
  }
  jwt = { valor: row.jwt, leido: Date.now() };
  return jwt.valor;
}

const fetcherLocal: HgiFetch = async (recurso, metodo, params, opts) => {
  const token = await tokenVigente();
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
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    // Token rechazado o caducado: se fuerza la relectura para el reintento de
    // fetchRango, por si producción ya lo renovó. Nunca se autentica.
    if (res.status === 401 || (res.status === 400 && raw.trim() === '')) {
      jwt = null;
      throw new Error(`HGINet devolvió ${res.status}: token rechazado o caducado.`);
    }
    if (!res.ok) throw new Error(`HGINet ${recurso}/${metodo} devolvió HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return JSON.parse(raw) as never;
  } finally {
    clearTimeout(timer);
  }
};

// -------------------------------------------------------------- main ------

async function yaReconstruidos(): Promise<Set<string>> {
  const rows = (await getSql()`
    SELECT mes FROM hgi_ventas_mensual WHERE por_proveedor IS NOT NULL
  `) as unknown as Array<{ mes: string }>;
  return new Set(rows.map((r) => r.mes));
}

async function main() {
  const hoy = hoyColombia();
  const mesActual = mesDe(hoy);
  const lista = meses();
  const hechos = await yaReconstruidos();
  log(`Reconstrucción ${HASTA} → ${DESDE} (${lista.length} meses)${DRY ? ' · DRY RUN, no escribe' : ''}`);

  let ok = 0;
  let fallos = 0;
  let saltados = 0;

  for (const [i, mes] of lista.entries()) {
    if (hechos.has(mes)) {
      saltados++;
      log(`${mes} · SALTADO (ya tiene por_proveedor)`);
      continue;
    }
    if (i > 0) await sleep(PAUSA_ENTRE_MESES_MS);

    const t0 = Date.now();
    try {
      const rango = rangoDeMes(mes, hoy);
      const lineas = await fetchRango(rango, fetcherLocal);
      const fila = agregarMes(mes, lineas, rango, mes === mesActual);

      const neta = fila.venta - fila.descuento; // `venta` es la bruta (ver agregarMes)
      const sProv = (fila.porProveedor ?? []).reduce((s, p) => s + p.venta, 0);
      const sZona = (fila.porZona ?? []).reduce((s, z) => s + z.venta, 0);
      const sCli = (fila.porZona ?? []).reduce((s, z) => s + z.clientes.reduce((t, c) => t + c.venta, 0), 0);
      const nCli = (fila.porZona ?? []).reduce((s, z) => s + z.clientes.length, 0);
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      const resumen =
        `${mes} · neta ${fmt(neta)} · ${fila.porProveedor?.length ?? 0} proveedores · ` +
        `${fila.porZona?.length ?? 0} zonas · ${nCli} clientes · ${fila.lineas} líneas · ${seg}s`;

      const difs = { proveedor: sProv - neta, zona: sZona - neta, clientes: sCli - neta };
      const cuadra = Object.values(difs).every((d) => Math.abs(d) <= TOLERANCIA);
      if (lineas.length === 0 || !cuadra) {
        fallos++;
        log(`${resumen} · FALLO (no escrito) · difs ${JSON.stringify(difs)} · líneas ${lineas.length}`);
        continue;
      }

      if (!DRY) await writeMes(fila);
      ok++;
      log(`${resumen} · OK${DRY ? ' (dry, no escrito)' : ''}`);
    } catch (err) {
      fallos++;
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      log(`${mes} · ${seg}s · FALLO (no escrito) · ${(err as Error).message}`);
    }
  }

  log(`FIN · ok ${ok} · fallos ${fallos} · saltados ${saltados}`);
}

main()
  .catch((err) => {
    log(`ABORTADO: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => getSql().end({ timeout: 5 }));
