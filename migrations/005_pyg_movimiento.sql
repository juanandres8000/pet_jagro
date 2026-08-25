-- Líneas de movimiento contable del P&G (DocumentosContables/Obtener).
--
-- UNA fila por línea de ComprobanteDetalle. La PK es el `Id` que emite HGINet:
-- verificado único global (126.427 Id distintos sobre 126.427 líneas en junio
-- 2026), así que reingestar la misma ventana es idempotente por ON CONFLICT (id).
--
-- Se descarta el pseudo-documento IdComprobante='0': no es un documento sino el
-- volcado de saldos por cuenta y tercero (~45k filas, ~38 MB, Debito=0,
-- Credito=0, SaldoAnterior poblado) que HGINet adjunta a CUALQUIER rango.
--
-- `ventana_desde`/`ventana_hasta` es el rango CONSULTADO, que no coincide con
-- `fecha`: una consulta de junio devuelve líneas fechadas 2026-07-01 (medido:
-- 958). Es lo que hace segura la sustitución — ver DELETE en lib/hgi/pygIngest.ts.
--
-- Idempotente (IF NOT EXISTS), igual que 001-004. También se crea init-on-use
-- desde lib/hgi/pygStore.ts.
--
-- DDL por sesión (5432), NO por el pooler (6543) — CLAUDE.md § Trampas del pooler.

CREATE TABLE IF NOT EXISTS pyg_movimiento (
  id              BIGINT PRIMARY KEY,               -- ComprobanteDetalle.Id
  fecha           DATE          NOT NULL,           -- Fecha de la LÍNEA, no de la cabecera
  -- 'YYYY-MM' derivado de `fecha`. Columna normal y no GENERATED: to_char(date)
  -- es STABLE (depende de DateStyle), y las columnas generadas exigen IMMUTABLE.
  -- La llena la ingesta cortando el ISO que ya manda HGINet.
  mes             TEXT          NOT NULL,
  periodo         SMALLINT      NOT NULL,           -- de la cabecera; 13 = cierre anual
  anio            SMALLINT      NOT NULL,
  id_comprobante  TEXT          NOT NULL,           -- '01','04','27'… nunca '0'
  documento       INTEGER       NOT NULL,
  cuenta          TEXT          NOT NULL,           -- CuentaPCGA, fallback CuentaNIIF
  -- NUMERIC y no DOUBLE PRECISION: se suman cientos de miles de líneas y hay que
  -- poder verificar débitos = créditos al peso (junio: 7.431.831.952 exactos).
  debito          NUMERIC(18,2) NOT NULL DEFAULT 0,
  credito         NUMERIC(18,2) NOT NULL DEFAULT 0,
  tercero         TEXT,
  referencia      TEXT,                             -- código de producto
  detalle         TEXT,
  ventana_desde   DATE          NOT NULL,
  ventana_hasta   DATE          NOT NULL,
  lote            UUID          NOT NULL,           -- corrida que escribió la fila
  ingestado_en    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pyg_mov_mes_cuenta_idx ON pyg_movimiento (mes, cuenta);
CREATE INDEX IF NOT EXISTS pyg_mov_clase_idx      ON pyg_movimiento (mes, left(cuenta, 1));
CREATE INDEX IF NOT EXISTS pyg_mov_ventana_idx    ON pyg_movimiento (ventana_desde, ventana_hasta, lote);
CREATE INDEX IF NOT EXISTS pyg_mov_fecha_idx      ON pyg_movimiento (fecha);
