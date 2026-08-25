import { randomUUID } from 'node:crypto';
import { getSql as getDb } from '../pg';
import { hgiFetchPorDefecto, type HgiFetch } from './pygFetch';

/**
 * Ingesta de movimiento contable del P&G: una VENTANA por corrida.
 *
 * Una ventana es un rango [desde, hasta] de `DocumentosContables/Obtener`. Un mes
 * cerrado se ingesta como una ventana mensual; el refresco incremental usará
 * ventanas de un día. Medido: el mes de junio 2026 son 107 MB y 80 s, mientras
 * que un día suelto son ~40 MB y ~37 s — porque CADA respuesta incluye el
 * pseudo-documento completo, así que 30 días sueltos son ~1,2 GB contra 107 MB
 * del mismo mes en una sola llamada.
 *
 * ============ QUÉ SE DESCARTA Y POR QUÉ ============
 *
 * 1. `IdComprobante === '0'`: no es un documento sino el volcado de saldos por
 *    cuenta y tercero (junio: 92.995 filas con Debito=0, Credito=0 y
 *    SaldoAnterior poblado). Sumarlo como movimiento sería un error de 3x en el
 *    conteo de líneas.
 * 2. Campos siempre en cero en la fuente: CentroCosto, SubcentroCosto, Tercero2,
 *    Base2 (verificado sobre 126.427 líneas). No se persisten.
 *
 * ============ POR QUÉ LA VENTANA NO ES LA FECHA ============
 *
 * Consultar [2026-06-01, 2026-06-30] devuelve 958 líneas fechadas 2026-07-01: la
 * apertura del mes siguiente. Esas líneas se guardan con su `fecha` REAL, así que
 * caen en el mes correcto, y `lineas_fuera_ventana` las deja auditables.
 *
 * De ahí que el DELETE de sustitución se acote por (ventana_desde, ventana_hasta)
 * y no por `fecha`: cada ventana sólo puede borrar las filas que ella misma
 * produjo en una corrida anterior. Acotarlo por fecha borraría filas que
 * pertenecen legítimamente a otra ventana.
 */

const DOCS_TIMEOUT_MS = 180_000;
/** Filas por INSERT. 2000 × 16 columnas queda holgado bajo el límite de parámetros. */
const LOTE_FILAS = 2000;

export interface Ventana {
  desde: string; // 'YYYY-MM-DD'
  hasta: string; // 'YYYY-MM-DD'
}

/** Línea cruda de ComprobanteDetalle (sólo los campos que se usan). */
interface DetalleRaw {
  Id?: number;
  CuentaPCGA?: string;
  CuentaNIIF?: string;
  Fecha?: string;
  Debito?: number;
  Credito?: number;
  Tercero?: string;
  Referencia?: string;
  Detalle?: string;
}

/** Cabecera cruda de DocumentosContables/Obtener. */
interface DocumentoRaw {
  IdComprobante?: string;
  Documento?: number;
  Ano?: number;
  Periodo?: number;
  Fecha?: string;
  ComprobanteDetalle?: DetalleRaw[];
}

export interface FilaMovimiento {
  id: number;
  fecha: string;
  mes: string;
  periodo: number;
  anio: number;
  id_comprobante: string;
  documento: number;
  cuenta: string;
  debito: number;
  credito: number;
  tercero: string | null;
  referencia: string | null;
  detalle: string | null;
  ventana_desde: string;
  ventana_hasta: string;
  lote: string;
}

export interface ResultadoIngesta {
  ventana: Ventana;
  lote: string;
  documentos: number;
  lineas: number;
  lineasPseudo: number;
  lineasFueraVentana: number;
  lineasDescartadas: number;
  debitos: number;
  creditos: number;
  cuadra: boolean;
  borradas: number;
  duracionMs: number;
  estado: 'ok' | 'vacio';
}

/**
 * Cuenta de la línea: `CuentaPCGA` con fallback a `CuentaNIIF` cuando llega '0'.
 *
 * Medido en junio: de 33.432 líneas de movimiento, 32.270 traen ambas IDÉNTICAS
 * (cero divergencias), 1.160 traen sólo CuentaPCGA y NINGUNA sólo CuentaNIIF. El
 * fallback está por simetría defensiva, no porque se haya observado usarse.
 */
export function cuentaDeLinea(l: DetalleRaw): string {
  const pcga = String(l.CuentaPCGA ?? '0');
  if (pcga && pcga !== '0') return pcga;
  const niif = String(l.CuentaNIIF ?? '0');
  return niif && niif !== '0' ? niif : '';
}

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** 'YYYY-MM-DDT00:00:00' → 'YYYY-MM-DD'. HGINet manda ISO sin zona horaria. */
const soloFecha = (iso: string): string => iso.slice(0, 10);

export interface Aplanado {
  filas: FilaMovimiento[];
  documentos: number;
  lineasPseudo: number;
  lineasFueraVentana: number;
  lineasDescartadas: number;
  debitos: number;
  creditos: number;
}

/**
 * Aplana la respuesta a filas persistibles. Pura: sin red y sin BD, para poder
 * verificar los conteos sobre un JSON guardado.
 */
export function aplanar(docs: DocumentoRaw[], ventana: Ventana, lote: string): Aplanado {
  const filas: FilaMovimiento[] = [];
  let documentos = 0;
  let lineasPseudo = 0;
  let lineasFueraVentana = 0;
  let lineasDescartadas = 0;
  let debitos = 0;
  let creditos = 0;

  for (const d of docs) {
    const comprobante = String(d.IdComprobante ?? '');
    const detalle = d.ComprobanteDetalle ?? [];

    // Pseudo-documento de saldos: se cuenta y se tira entero.
    if (comprobante === '0') {
      lineasPseudo += detalle.length;
      continue;
    }
    documentos++;

    for (const l of detalle) {
      const id = Number(l.Id);
      // Sin Id no hay PK posible: es lo único que se descarta.
      if (!Number.isFinite(id) || id <= 0) {
        lineasDescartadas++;
        continue;
      }
      // Cuenta vacía se GUARDA como '' en vez de descartarse. En junio son 2
      // líneas (comp 35/doc 18529, glosas "INGRESO" y "GENERAL") sin CuentaPCGA
      // ni CuentaNIIF y con débito y crédito en cero. Conservarlas mantiene la
      // tabla reconciliable línea a línea con HGINet; las vistas del P&G las
      // excluyen solas porque agrupan por left(cuenta,1) y '' no es ninguna clase.
      const cuenta = cuentaDeLinea(l);
      const fecha = soloFecha(String(l.Fecha ?? d.Fecha ?? ''));
      if (!fecha) {
        lineasDescartadas++;
        continue;
      }
      if (fecha < ventana.desde || fecha > ventana.hasta) lineasFueraVentana++;

      const debito = num(l.Debito);
      const credito = num(l.Credito);
      debitos += debito;
      creditos += credito;

      filas.push({
        id,
        fecha,
        mes: fecha.slice(0, 7),
        periodo: Number(d.Periodo ?? 0),
        anio: Number(d.Ano ?? Number(fecha.slice(0, 4))),
        id_comprobante: comprobante,
        documento: Number(d.Documento ?? 0),
        cuenta,
        debito,
        credito,
        tercero: l.Tercero && l.Tercero !== '0' ? String(l.Tercero) : null,
        referencia: l.Referencia && l.Referencia !== '0' ? String(l.Referencia) : null,
        detalle: l.Detalle ? String(l.Detalle) : null,
        ventana_desde: ventana.desde,
        ventana_hasta: ventana.hasta,
        lote,
      });
    }
  }

  return { filas, documentos, lineasPseudo, lineasFueraVentana, lineasDescartadas, debitos, creditos };
}

/**
 * Se memoiza la PROMESA en vuelo, no un booleano — CLAUDE.md § Trampas del
 * pooler. Ver la nota extensa en lib/hgi/ventasMensualStore.ts.
 */
let tablePromise: Promise<void> | null = null;
export function ensureMovimientoTables(): Promise<void> {
  if (!tablePromise) {
    tablePromise = crearTablas().catch((err) => {
      tablePromise = null; // permite reintentar si falló
      throw err;
    });
  }
  return tablePromise;
}

async function crearTablas(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS pyg_movimiento (
      id              BIGINT PRIMARY KEY,
      fecha           DATE          NOT NULL,
      mes             TEXT          NOT NULL,
      periodo         SMALLINT      NOT NULL,
      anio            SMALLINT      NOT NULL,
      id_comprobante  TEXT          NOT NULL,
      documento       INTEGER       NOT NULL,
      cuenta          TEXT          NOT NULL,
      debito          NUMERIC(18,2) NOT NULL DEFAULT 0,
      credito         NUMERIC(18,2) NOT NULL DEFAULT 0,
      tercero         TEXT,
      referencia      TEXT,
      detalle         TEXT,
      ventana_desde   DATE          NOT NULL,
      ventana_hasta   DATE          NOT NULL,
      lote            UUID          NOT NULL,
      ingestado_en    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS pyg_ventana_control (
      ventana_desde        DATE NOT NULL,
      ventana_hasta        DATE NOT NULL,
      estado               TEXT NOT NULL DEFAULT 'pendiente',
      lineas               INTEGER NOT NULL DEFAULT 0,
      documentos           INTEGER NOT NULL DEFAULT 0,
      lineas_pseudo        INTEGER NOT NULL DEFAULT 0,
      lineas_fuera_ventana INTEGER NOT NULL DEFAULT 0,
      bytes                BIGINT  NOT NULL DEFAULT 0,
      duracion_ms          INTEGER NOT NULL DEFAULT 0,
      debitos              NUMERIC(18,2) NOT NULL DEFAULT 0,
      creditos             NUMERIC(18,2) NOT NULL DEFAULT 0,
      cuadra               BOOLEAN,
      intentos             SMALLINT NOT NULL DEFAULT 0,
      ultimo_error         TEXT,
      lote                 UUID,
      actualizado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ventana_desde, ventana_hasta)
    )
  `;
}

/**
 * Ingesta una ventana: la trae de HGINet, la aplana y la persiste.
 *
 * Todo lo que toca la BD va en UNA transacción por ventana: los INSERT por
 * lotes, el DELETE de sustitución y el UPDATE de control son un solo acto. Si
 * algo falla a mitad, la ventana queda como estaba y el control registra el
 * error para que el reintento la retome.
 */
export async function pygIngest(ventana: Ventana, traer: HgiFetch = hgiFetchPorDefecto): Promise<ResultadoIngesta> {
  await ensureMovimientoTables();
  const sql = getDb();
  const lote = randomUUID();
  const t0 = Date.now();

  // Marca de intento ANTES de salir a la red: si el lambda muere en el fetch, la
  // ventana queda registrada como 'pendiente' con el intento contado, no invisible.
  await sql`
    INSERT INTO pyg_ventana_control (ventana_desde, ventana_hasta, estado, intentos, lote, actualizado_en)
    VALUES (${ventana.desde}, ${ventana.hasta}, 'pendiente', 1, ${lote}, NOW())
    ON CONFLICT (ventana_desde, ventana_hasta) DO UPDATE
      SET estado = 'pendiente',
          intentos = pyg_ventana_control.intentos + 1,
          lote = EXCLUDED.lote,
          actualizado_en = NOW()
  `;

  let docs: DocumentoRaw[];
  try {
    // La firma es POSICIONAL: el routing de WebAPI de HGINet es por firma, no por
    // nombre. Con la convención codigo_* responde 404.
    docs = await traer<DocumentoRaw[]>(
      'DocumentosContables',
      'Obtener',
      {
        empresa: '1',
        comprobante: '*',
        documento: '*',
        fecha_inicial: ventana.desde,
        fecha_final: ventana.hasta,
      },
      { timeoutMs: DOCS_TIMEOUT_MS },
    );
  } catch (err) {
    await marcarError(ventana, (err as Error).message, Date.now() - t0);
    throw err;
  }

  if (!Array.isArray(docs)) {
    const mensaje = 'DocumentosContables/Obtener no devolvió un array';
    await marcarError(ventana, mensaje, Date.now() - t0);
    throw new Error(mensaje);
  }

  const ap = aplanar(docs, ventana, lote);
  // Se libera la respuesta cruda antes de escribir: son ~100 MB de objetos y el
  // INSERT por lotes no la necesita.
  docs.length = 0;

  let borradas = 0;
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < ap.filas.length; i += LOTE_FILAS) {
        const lotePart = ap.filas.slice(i, i + LOTE_FILAS);
        await tx`
          INSERT INTO pyg_movimiento ${tx(
            lotePart,
            'id', 'fecha', 'mes', 'periodo', 'anio', 'id_comprobante', 'documento',
            'cuenta', 'debito', 'credito', 'tercero', 'referencia', 'detalle',
            'ventana_desde', 'ventana_hasta', 'lote',
          )}
          ON CONFLICT (id) DO UPDATE
            SET fecha = EXCLUDED.fecha,
                mes = EXCLUDED.mes,
                periodo = EXCLUDED.periodo,
                anio = EXCLUDED.anio,
                id_comprobante = EXCLUDED.id_comprobante,
                documento = EXCLUDED.documento,
                cuenta = EXCLUDED.cuenta,
                debito = EXCLUDED.debito,
                credito = EXCLUDED.credito,
                tercero = EXCLUDED.tercero,
                referencia = EXCLUDED.referencia,
                detalle = EXCLUDED.detalle,
                ventana_desde = EXCLUDED.ventana_desde,
                ventana_hasta = EXCLUDED.ventana_hasta,
                lote = EXCLUDED.lote,
                ingestado_en = NOW()
        `;
      }

      // Sustitución: lo que ESTA ventana trajo antes y ya no trae fue anulado o
      // reasignado en HGINet. Acotado por ventana + lote: nunca toca filas de otra.
      const del = (await tx`
        DELETE FROM pyg_movimiento
         WHERE ventana_desde = ${ventana.desde}
           AND ventana_hasta = ${ventana.hasta}
           AND lote <> ${lote}
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      borradas = del.length;

      const cuadra = ap.debitos.toFixed(2) === ap.creditos.toFixed(2);
      await tx`
        UPDATE pyg_ventana_control
           SET estado = ${ap.filas.length === 0 ? 'vacio' : 'ok'},
               lineas = ${ap.filas.length},
               documentos = ${ap.documentos},
               lineas_pseudo = ${ap.lineasPseudo},
               lineas_fuera_ventana = ${ap.lineasFueraVentana},
               duracion_ms = ${Date.now() - t0},
               debitos = ${ap.debitos.toFixed(2)},
               creditos = ${ap.creditos.toFixed(2)},
               cuadra = ${cuadra},
               ultimo_error = NULL,
               actualizado_en = NOW()
         WHERE ventana_desde = ${ventana.desde} AND ventana_hasta = ${ventana.hasta}
      `;
    });
  } catch (err) {
    await marcarError(ventana, (err as Error).message, Date.now() - t0);
    throw err;
  }

  return {
    ventana,
    lote,
    documentos: ap.documentos,
    lineas: ap.filas.length,
    lineasPseudo: ap.lineasPseudo,
    lineasFueraVentana: ap.lineasFueraVentana,
    lineasDescartadas: ap.lineasDescartadas,
    debitos: ap.debitos,
    creditos: ap.creditos,
    cuadra: ap.debitos.toFixed(2) === ap.creditos.toFixed(2),
    borradas,
    duracionMs: Date.now() - t0,
    estado: ap.filas.length === 0 ? 'vacio' : 'ok',
  };
}

/** Registra el fallo en el control sin tumbar la corrida que lo reporta. */
async function marcarError(ventana: Ventana, mensaje: string, duracionMs: number): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE pyg_ventana_control
         SET estado = 'error', ultimo_error = ${mensaje.slice(0, 500)},
             duracion_ms = ${duracionMs}, actualizado_en = NOW()
       WHERE ventana_desde = ${ventana.desde} AND ventana_hasta = ${ventana.hasta}
    `;
  } catch (err) {
    console.error('[pyg] no se pudo registrar el error de la ventana:', (err as Error).message);
  }
}
