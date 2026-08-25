import { getSql as getDb } from '../pg';
import { ratioMinimo } from './snapshotStore';
import { hgiFetchPorDefecto, type HgiFetch } from './pygFetch';

/**
 * Store del plan de cuentas PCGA (tabla pyg_cuenta).
 * Equivale a migrations/007_pyg_cuenta.sql.
 *
 * La fuente es `PlanContable/ObtenerPCGA`, un array plano de 19 campos sin
 * jerarquía explícita: no hay campo padre ni campo nivel. La jerarquía es
 * POSICIONAL por longitud del código (PUC colombiano) y aquí se materializa en
 * `nivel` y `es_hoja` para no recalcularla en cada query del P&G.
 *
 * Se usa PCGA y no NIIF porque es el que llenan los movimientos: en junio 2026,
 * de 33.432 líneas 32.270 traen ambas cuentas IDÉNTICAS, 1.160 traen sólo
 * CuentaPCGA y NINGUNA trae sólo CuentaNIIF.
 */

const PLAN_TIMEOUT_MS = 60_000;

/** Longitudes válidas de código en el PUC → nivel. Medido: {1,2,4,6,8}. */
const NIVEL_POR_LONGITUD: Record<number, number> = { 1: 1, 2: 2, 4: 3, 6: 4, 8: 5 };

/** Fila cruda de PlanContable/ObtenerPCGA (sólo lo que se persiste). */
interface PlanContableRaw {
  Cuenta?: string | number;
  Descripcion?: string;
  Estado?: number;
}

export interface CuentaPlan {
  cuenta: string;
  descripcion: string;
  nivel: number;
  esHoja: boolean;
  estado: number;
}

/**
 * Se memoiza la PROMESA en vuelo, no un booleano — CLAUDE.md § Trampas del
 * pooler. Con un flag, dos llamadas concurrentes emiten dos CREATE TABLE, cada
 * uno pide ACCESS EXCLUSIVE y sobre la única conexión (max: 1) se bloquean entre
 * sí hasta el timeout. Sólo se dispara con la tabla aún inexistente, que es
 * exactamente el estreno de una tabla nueva como ésta.
 */
let tablePromise: Promise<void> | null = null;
export function ensureCuentaTable(): Promise<void> {
  if (!tablePromise) {
    tablePromise = crearTabla().catch((err) => {
      tablePromise = null; // permite reintentar si falló
      throw err;
    });
  }
  return tablePromise;
}

async function crearTabla(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS pyg_cuenta (
      cuenta      TEXT PRIMARY KEY,
      descripcion TEXT NOT NULL,
      clase       CHAR(1) GENERATED ALWAYS AS (left(cuenta, 1)) STORED,
      grupo       TEXT    GENERATED ALWAYS AS (left(cuenta, 2)) STORED,
      nivel       SMALLINT NOT NULL,
      es_hoja     BOOLEAN  NOT NULL,
      estado      SMALLINT NOT NULL DEFAULT 1,
      built_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Calcula nivel y es_hoja de un plan completo.
 *
 * `es_hoja` = ninguna otra cuenta del plan la tiene como prefijo estricto. Se
 * resuelve con un Set de prefijos en vez de comparar todas contra todas (O(n·L)
 * y no O(n²)): para cada cuenta se marcan todos sus prefijos como "tienen
 * descendiente".
 */
export function derivarJerarquia(cuentas: Array<{ cuenta: string; descripcion: string; estado: number }>): CuentaPlan[] {
  const conDescendiente = new Set<string>();
  for (const { cuenta } of cuentas) {
    for (let i = 1; i < cuenta.length; i++) conDescendiente.add(cuenta.slice(0, i));
  }
  return cuentas.map(({ cuenta, descripcion, estado }) => ({
    cuenta,
    descripcion,
    // Longitud fuera del PUC: se guarda igual con nivel 0 en vez de descartarla,
    // para que una cuenta rara no desaparezca del plan sin dejar rastro.
    nivel: NIVEL_POR_LONGITUD[cuenta.length] ?? 0,
    esHoja: !conDescendiente.has(cuenta),
    estado,
  }));
}

/** Normaliza la respuesta cruda descartando filas sin código de cuenta. */
export function normalizarPlan(raw: PlanContableRaw[]): Array<{ cuenta: string; descripcion: string; estado: number }> {
  const out: Array<{ cuenta: string; descripcion: string; estado: number }> = [];
  for (const r of raw) {
    const cuenta = String(r.Cuenta ?? '').trim();
    if (!cuenta) continue;
    out.push({
      cuenta,
      descripcion: String(r.Descripcion ?? '').trim(),
      estado: Number(r.Estado ?? 1),
    });
  }
  return out;
}

export interface ResultadoPlan {
  filas: number;
  hojas: number;
  porNivel: Record<number, number>;
  /** true si el guard de ratio rechazó la escritura y se conservó el plan viejo. */
  rechazadoPorGuard: boolean;
  existentes: number;
}

/**
 * Trae el plan PCGA de HGINet y lo reemplaza ENTERO en una sola transacción.
 *
 * GUARD DE TAMAÑO: se reusa `ratioMinimo()` de snapshotStore (env
 * SNAPSHOT_MIN_RATIO, default 0.5) para que un solo umbral gobierne los dos
 * caminos de escritura del proyecto. Si HGINet devuelve menos del ratio de las
 * cuentas existentes, se hace ROLLBACK y se conserva el plan anterior: sin esto,
 * una lectura degradada dejaría el P&G sin plan y todas las clasificaciones en
 * null, que es peor que servir un plan de ayer.
 */
export async function refreshPlanCuentas(traer: HgiFetch = hgiFetchPorDefecto): Promise<ResultadoPlan> {
  await ensureCuentaTable();

  const raw = await traer<PlanContableRaw[]>('PlanContable', 'ObtenerPCGA', { codigo: '*' }, {
    timeoutMs: PLAN_TIMEOUT_MS,
  });
  if (!Array.isArray(raw)) throw new Error('PlanContable/ObtenerPCGA no devolvió un array');

  const plan = derivarJerarquia(normalizarPlan(raw));
  return escribirPlan(plan);
}

/** Escribe el plan ya derivado. Separado de la traída para poder testear sin red. */
export async function escribirPlan(plan: CuentaPlan[]): Promise<ResultadoPlan> {
  await ensureCuentaTable();
  const sql = getDb();

  const porNivel: Record<number, number> = {};
  for (const c of plan) porNivel[c.nivel] = (porNivel[c.nivel] ?? 0) + 1;
  const hojas = plan.filter((c) => c.esHoja).length;

  let rechazadoPorGuard = false;
  let existentes = 0;

  // Transacción única: el plan se reemplaza entero o no se toca. Un DELETE+INSERT
  // sin transacción dejaría la tabla vacía si el INSERT falla a mitad.
  await sql.begin(async (tx) => {
    const prev = (await tx`SELECT count(*)::int AS n FROM pyg_cuenta`) as unknown as Array<{ n: number }>;
    existentes = prev[0]?.n ?? 0;

    const ratio = ratioMinimo();
    if (existentes > 0 && plan.length < ratio * existentes) {
      rechazadoPorGuard = true;
      console.error(
        `[pyg_cuenta] el plan traído tiene ${plan.length} cuentas sobre ${existentes} existentes ` +
          `(ratio ${(plan.length / existentes).toFixed(3)} < umbral ${ratio}), rechazado`,
      );
      // Sale por excepción para forzar el ROLLBACK; se captura fuera.
      throw new GuardRechazado();
    }

    await tx`DELETE FROM pyg_cuenta`;
    // Lote único: 801 filas caben de sobra en un INSERT.
    await tx`
      INSERT INTO pyg_cuenta ${tx(
        plan.map((c) => ({
          cuenta: c.cuenta,
          descripcion: c.descripcion,
          nivel: c.nivel,
          es_hoja: c.esHoja,
          estado: c.estado,
        })),
        'cuenta',
        'descripcion',
        'nivel',
        'es_hoja',
        'estado',
      )}
    `;
  }).catch((err) => {
    if (err instanceof GuardRechazado) return; // plan viejo preservado
    throw err;
  });

  return {
    filas: rechazadoPorGuard ? 0 : plan.length,
    hojas: rechazadoPorGuard ? 0 : hojas,
    porNivel: rechazadoPorGuard ? {} : porNivel,
    rechazadoPorGuard,
    existentes,
  };
}

/** Marca interna para abortar la transacción sin confundirla con un fallo real. */
class GuardRechazado extends Error {
  constructor() {
    super('plan rechazado por el guard de ratio');
    this.name = 'GuardRechazado';
  }
}

/** Conteos del plan persistido. Para validación y para el payload del endpoint. */
export async function readResumenPlan(): Promise<{ filas: number; hojas: number; porNivel: Record<number, number> }> {
  await ensureCuentaTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT nivel, count(*)::int AS n, count(*) FILTER (WHERE es_hoja)::int AS hojas
      FROM pyg_cuenta GROUP BY nivel ORDER BY nivel
  `) as unknown as Array<{ nivel: number; n: number; hojas: number }>;
  const porNivel: Record<number, number> = {};
  let filas = 0;
  let hojas = 0;
  for (const r of rows) {
    porNivel[r.nivel] = r.n;
    filas += r.n;
    hojas += r.hojas;
  }
  return { filas, hojas, porNivel };
}
