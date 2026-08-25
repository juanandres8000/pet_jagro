-- Control de ingesta del P&G: UNA fila por ventana consultada.
--
-- Es el cursor del backfill y el log de reintentos. Una ventana es un rango
-- [desde, hasta] de DocumentosContables/Obtener: un mes cerrado se ingesta como
-- una ventana mensual (107 MB / 80 s medidos para junio 2026), y el refresco
-- incremental usará ventanas de un día. La PK compuesta permite que convivan
-- ambas granularidades sobre las mismas fechas.
--
-- Idempotente (IF NOT EXISTS). DDL por sesión (5432), no por el pooler.

CREATE TABLE IF NOT EXISTS pyg_ventana_control (
  ventana_desde        DATE NOT NULL,
  ventana_hasta        DATE NOT NULL,
  estado               TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|ok|error|vacio
  lineas               INTEGER NOT NULL DEFAULT 0,         -- movimiento guardado
  documentos           INTEGER NOT NULL DEFAULT 0,         -- cabeceras reales (sin el pseudo)
  lineas_pseudo        INTEGER NOT NULL DEFAULT 0,         -- descartadas de IdComprobante='0'
  -- Líneas cuya `Fecha` cae fuera de [desde, hasta]. No es un error: HGINet
  -- devuelve la apertura del mes siguiente. Se guardan con su fecha real y este
  -- contador las hace visibles en vez de silenciarlas.
  lineas_fuera_ventana INTEGER NOT NULL DEFAULT 0,
  -- Tamaño del cuerpo en bytes. Queda en 0 cuando la ingesta va por hgiGet, que
  -- devuelve el JSON ya parseado y no expone el body ni Content-Length.
  bytes                BIGINT  NOT NULL DEFAULT 0,
  duracion_ms          INTEGER NOT NULL DEFAULT 0,
  debitos              NUMERIC(18,2) NOT NULL DEFAULT 0,
  creditos             NUMERIC(18,2) NOT NULL DEFAULT 0,
  cuadra               BOOLEAN,                            -- debitos = creditos
  intentos             SMALLINT NOT NULL DEFAULT 0,
  ultimo_error         TEXT,
  lote                 UUID,
  actualizado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ventana_desde, ventana_hasta)
);

CREATE INDEX IF NOT EXISTS pyg_ventana_estado_idx ON pyg_ventana_control (estado, ventana_desde);
