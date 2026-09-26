/**
 * Reconstruye meses de hgi_ventas_mensual desde la terminal local, reanudable.
 *
 * ══ CÓMO CORRERLO ═════════════════════════════════════════════════════════
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs scripts/rebuild-meses.ts [--dry] [--mes=YYYY-MM]
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
 * Reanudable: salta los meses cuyo `por_zona` ya está por vendedor ("Zona N",
 * ver lib/hgi/zonas.ts). Los construidos con la regla anterior agrupan por
 * ciudad y se rehacen.
 * `--dry` construye y verifica sin escribir. `--mes=YYYY-MM` procesa sólo ese
 * mes, aunque ya esté hecho.
 * Por mes imprime la distribución por zona, los vendedores sin zona y los
 * clientes que caen en "Sin zona".
 */
import { getSql } from '../lib/pg';
import { fetchRango, hoyColombia } from '../lib/hgi/ventas';
import { agregarMes, rangoDeMes, mesDe } from '../lib/hgi/ventasMensual';
import { writeMes } from '../lib/hgi/ventasMensualStore';
import type { HgiFetch } from '../lib/hgi/pygFetch';
import { ZONA_SIN, esPorZonaVendedor, zonaDeVendedor } from '../lib/hgi/zonas';
import type { VentaPorZona } from '../lib/hgi/mappers/ventas';

/** 2026-09 → 2025-01, del más reciente al más antiguo. 2024 no se toca. */
const DESDE = '2025-01';
const HASTA = '2026-09';
/** Respiro entre meses, además de la pausa entre ventanas de fetchRango. */
const PAUSA_ENTRE_MESES_MS = 5_000;
/** Tolerancia de la verificación, en pesos (sumas en coma flotante). */
const TOLERANCIA = 1;

const DRY = process.argv.includes('--dry');
const MES = process.argv.find((a) => a.startsWith('--mes='))?.slice('--mes='.length);
if (MES !== undefined && !/^\d{4}-\d{2}$/.test(MES)) throw new Error(`--mes inválido: ${MES} (formato YYYY-MM)`);
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
/**
 * Lectura en vuelo, compartida. fetchRango corre 2 ventanas en paralelo y las
 * dos piden token a la vez: dos SELECT simultáneos sobre el cliente max: 1 del
 * pooler en transaction mode cuelgan la conexión sin error (trampa 2 del pooler
 * en CLAUDE.md). Memoizando la PROMESA sale una sola query.
 */
let lectura: Promise<string> | null = null;

function tokenVigente(): Promise<string> {
  if (jwt && Date.now() - jwt.leido < 60_000) return Promise.resolve(jwt.valor);
  if (!lectura) {
    lectura = leerToken().finally(() => {
      lectura = null;
    });
  }
  return lectura;
}

async function leerToken(): Promise<string> {
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
    SELECT mes, por_zona FROM hgi_ventas_mensual WHERE por_proveedor IS NOT NULL AND por_zona IS NOT NULL
  `) as unknown as Array<{ mes: string; por_zona: VentaPorZona[] }>;
  return new Set(rows.filter((r) => esPorZonaVendedor(r.por_zona)).map((r) => r.mes));
}

/** Distribución por zona, vendedores sin zona y clientes que caen en "Sin zona". */
function reporteZonas(zonas: VentaPorZona[], neta: number, vendedoresSinZona: Map<string, number>) {
  const pct = (v: number) => (neta === 0 ? '—' : `${((v / neta) * 100).toFixed(2)} %`);
  const nits = new Map<string, number>();
  for (const z of zonas) for (const c of z.clientes) nits.set(c.nit, (nits.get(c.nit) ?? 0) + 1);
  const multi = [...nits.values()].filter((n) => n > 1).length;
  log(`   zona         venta neta          %        clientes  docs`);
  for (const z of zonas) {
    log(
      `   ${z.zona.padEnd(10)} ${fmt(z.venta).padStart(16)}  ${pct(z.venta).padStart(8)}  ${String(z.clientes.length).padStart(8)}  ${String(z.documentos).padStart(5)}`,
    );
  }
  log(`   clientes distintos ${nits.size} · en más de una zona ${multi}`);
  if (vendedoresSinZona.size === 0) log('   vendedores sin zona: ninguno');
  for (const [v, venta] of vendedoresSinZona) log(`   vendedor sin zona: ${JSON.stringify(v)} · ${fmt(venta)}`);
  const sin = zonas.find((z) => z.zona === ZONA_SIN);
  for (const c of sin?.clientes ?? []) log(`   cliente en ${ZONA_SIN}: ${c.nit} ${c.nombre} · ${fmt(c.venta)} · ${c.documentos} docs`);
}

interface Guardado {
  venta: number;
  descuento: number;
  por_zona: VentaPorZona[] | null;
  built_at: Date;
  hasta: string;
}

/** Fila guardada del mes. Se lee ANTES de writeMes: después sólo se vería a sí misma. */
async function leerGuardado(mes: string): Promise<Guardado | undefined> {
  const rows = (await getSql()`
    SELECT venta, descuento, por_zona, built_at, hasta FROM hgi_ventas_mensual WHERE mes = ${mes}
  `) as unknown as Guardado[];
  return rows[0];
}

/**
 * Antes/después contra la fila guardada: la venta neta del mes no depende de
 * cómo se agrupe la zona. En el mes en curso puede moverse por facturas nuevas
 * entre el built_at guardado y esta corrida; por eso se imprime el built_at.
 */
function baseline(f: Guardado | undefined, neta: number, zonas: VentaPorZona[]) {
  if (!f) return log('   baseline: no hay fila guardada para el mes');
  const netaAntes = Number(f.venta) - Number(f.descuento);
  const zonaAntes = (f.por_zona ?? []).reduce((s, z) => s + z.venta, 0);
  const zonaDespues = zonas.reduce((s, z) => s + z.venta, 0);
  log(`   baseline guardado (built_at ${new Date(f.built_at).toISOString()}, hasta ${f.hasta}): neta ${fmt(netaAntes)} · Σ por_zona ${fmt(zonaAntes)} en ${f.por_zona?.length ?? 0} zonas`);
  log(`   después: neta ${fmt(neta)} · Σ por_zona ${fmt(zonaDespues)} en ${zonas.length} zonas · Δ neta ${fmt(neta - netaAntes)}`);
}

async function main() {
  const hoy = hoyColombia();
  const mesActual = mesDe(hoy);
  const lista = MES ? [MES] : meses();
  const hechos = MES ? new Set<string>() : await yaReconstruidos();
  log(
    `Reconstrucción ${MES ?? `${HASTA} → ${DESDE}`} (${lista.length} meses)${DRY ? ' · DRY RUN, no escribe' : ''}`,
  );

  let ok = 0;
  let fallos = 0;
  let saltados = 0;

  for (const [i, mes] of lista.entries()) {
    if (hechos.has(mes)) {
      saltados++;
      log(`${mes} · SALTADO (ya tiene por_zona por vendedor)`);
      continue;
    }
    if (i > 0) await sleep(PAUSA_ENTRE_MESES_MS);

    const t0 = Date.now();
    try {
      const rango = rangoDeMes(mes, hoy);
      const lineas = await fetchRango(rango, fetcherLocal);
      const fila = agregarMes(mes, lineas, rango, mes === mesActual);
      const vendedoresSinZona = new Map(
        fila.porVendedor.filter((v) => zonaDeVendedor(v.clave) === ZONA_SIN).map((v) => [v.clave, v.venta] as const),
      );

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

      const guardado = await leerGuardado(mes);
      if (!DRY) await writeMes(fila);
      ok++;
      log(`${resumen} · OK${DRY ? ' (dry, no escrito)' : ''}`);
      reporteZonas(fila.porZona ?? [], neta, vendedoresSinZona);
      baseline(guardado, neta, fila.porZona ?? []);
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
