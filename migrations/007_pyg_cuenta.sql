-- Plan de cuentas PCGA (PlanContable/ObtenerPCGA).
--
-- Tabla propia y no un dataset de hgi_snapshot porque las vistas del P&G la
-- JOINean por prefijo de código; hacerlo contra el JSONB del snapshot es hostil.
-- A cambio, pygCuentaStore replica el guard de tamaño reusando ratioMinimo().
--
-- El PCGA es subconjunto estricto del NIIF (medido: 0 cuentas exclusivas de
-- PCGA, 6 exclusivas de NIIF) y en los movimientos CuentaNIIF y CuentaPCGA son
-- idénticas cuando ambas vienen pobladas (32.270 casos, 0 divergencias).
--
-- Idempotente (IF NOT EXISTS). DDL por sesión (5432), no por el pooler.

CREATE TABLE IF NOT EXISTS pyg_cuenta (
  cuenta      TEXT PRIMARY KEY,
  descripcion TEXT NOT NULL,
  -- left(text,int) SÍ es IMMUTABLE, así que estas dos sí pueden ser generadas.
  clase       CHAR(1) GENERATED ALWAYS AS (left(cuenta, 1)) STORED,
  grupo       TEXT    GENERATED ALWAYS AS (left(cuenta, 2)) STORED,
  -- Nivel por LONGITUD del código: 1=clase 2=grupo 4=cuenta 6=subcuenta
  -- 8=auxiliar. La fuente no trae campo padre ni campo nivel; el padre de una
  -- cuenta es su prefijo. Distribución medida en PCGA: {1:7,2:28,4:91,6:322,8:353}.
  nivel       SMALLINT NOT NULL,
  -- Hoja = ninguna otra cuenta la tiene como prefijo estricto. Es lo que
  -- distingue cuenta de movimiento de cuenta de mayor, que la fuente tampoco marca.
  es_hoja     BOOLEAN  NOT NULL,
  estado      SMALLINT NOT NULL DEFAULT 1,   -- 1 = activa
  built_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pyg_cuenta_clase_idx ON pyg_cuenta (clase, nivel);
