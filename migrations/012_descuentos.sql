-- Descuentos diferenciados: precio cero en ventas y lo que el laboratorio
-- devuelve en compras. Ver docs/DESCUENTOS.md.
--
-- Tres tablas NUEVAS; no altera ninguna existente.
--
--  dd_linea            Líneas de detalle de HGINet que el módulo necesita ver una
--                      por una: de ventas, TODAS las líneas de cada factura que
--                      tenga al menos una línea en precio cero (el reporte por
--                      laboratorio muestra la pagada junto a la regalada); de
--                      compras, todas las líneas de las transacciones de compra y
--                      bonificados (40, 45, 05, 33, 32).
--  dd_venta_agregado   Venta / costo / descuento por mes y laboratorio de TODAS
--                      las ventas de la ventana, para el margen con y sin precio
--                      cero. No se guardan las ~16 mil líneas mensuales.
--  dd_ventana_control  Cursor e historial de la ingesta, una fila por ventana.
--
-- Mismo esquema de sustitución que pyg_movimiento: cada ventana sólo borra lo
-- que ella misma escribió con otro lote (nunca se borra por fecha).
--
-- Idempotente (IF NOT EXISTS). DDL por sesión (5432), no por el pooler.

CREATE TABLE IF NOT EXISTS dd_linea (
  id                  BIGINT PRIMARY KEY,             -- Id de línea de HGINet
  fuente              TEXT          NOT NULL,         -- venta | compra
  tipo                TEXT          NOT NULL,         -- ver lib/hgi/descuentos/mappers.ts (TipoLinea)
  fecha               DATE          NOT NULL,
  mes                 TEXT          NOT NULL,         -- 'YYYY-MM' de `fecha`
  codigo_transaccion  TEXT          NOT NULL,
  nombre_transaccion  TEXT,
  documento           INTEGER       NOT NULL,
  nit_tercero         TEXT,
  nombre_tercero      TEXT,
  nit_proveedor       TEXT,                           -- laboratorio dueño del producto
  nombre_proveedor    TEXT,
  codigo_producto     TEXT          NOT NULL,
  nombre_producto     TEXT,
  cantidad            NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_unitario      NUMERIC(18,2) NOT NULL DEFAULT 0,
  valor_total         NUMERIC(18,2) NOT NULL DEFAULT 0, -- ValorTotalDetalle (antes del descuento)
  descuento           NUMERIC(18,2) NOT NULL DEFAULT 0, -- ValorDescuentoDetalle
  costo_unitario      NUMERIC(18,2) NOT NULL DEFAULT 0,
  costo_total         NUMERIC(18,2) NOT NULL DEFAULT 0,
  ventana_desde       DATE          NOT NULL,
  ventana_hasta       DATE          NOT NULL,
  lote                UUID          NOT NULL,
  ingestado_en        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dd_linea_mes_prov_idx ON dd_linea (mes, nit_proveedor, tipo);
CREATE INDEX IF NOT EXISTS dd_linea_doc_idx      ON dd_linea (fuente, codigo_transaccion, documento);
CREATE INDEX IF NOT EXISTS dd_linea_ventana_idx  ON dd_linea (ventana_desde, ventana_hasta, lote);

CREATE TABLE IF NOT EXISTS dd_venta_agregado (
  ventana_desde   DATE          NOT NULL,
  ventana_hasta   DATE          NOT NULL,
  mes             TEXT          NOT NULL,
  nit_proveedor   TEXT          NOT NULL,             -- '' si HGINet no trae proveedor
  nombre_proveedor TEXT,
  venta_bruta     NUMERIC(18,2) NOT NULL DEFAULT 0,   -- Σ ValorTotalDetalle (facturas − notas)
  descuento       NUMERIC(18,2) NOT NULL DEFAULT 0,   -- Σ ValorDescuentoDetalle
  costo           NUMERIC(18,2) NOT NULL DEFAULT 0,   -- Σ CostoTotal (notas en negativo)
  costo_precio_cero NUMERIC(18,2) NOT NULL DEFAULT 0, -- parte de `costo` que es precio cero
  lista_precio_cero NUMERIC(18,2) NOT NULL DEFAULT 0, -- precio de lista de lo regalado
  unidades_precio_cero NUMERIC(14,2) NOT NULL DEFAULT 0,
  lineas          INTEGER       NOT NULL DEFAULT 0,
  lote            UUID          NOT NULL,
  PRIMARY KEY (ventana_desde, ventana_hasta, mes, nit_proveedor)
);

CREATE TABLE IF NOT EXISTS dd_ventana_control (
  ventana_desde   DATE NOT NULL,
  ventana_hasta   DATE NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|ok|error
  lineas_venta    INTEGER NOT NULL DEFAULT 0,         -- líneas de venta leídas de HGINet
  lineas_guardadas INTEGER NOT NULL DEFAULT 0,        -- filas escritas en dd_linea
  lineas_compra   INTEGER NOT NULL DEFAULT 0,
  docs_precio_cero INTEGER NOT NULL DEFAULT 0,
  duracion_ms     INTEGER NOT NULL DEFAULT 0,
  intentos        SMALLINT NOT NULL DEFAULT 0,
  ultimo_error    TEXT,
  lote            UUID,
  -- Última ingesta EXITOSA. Un refresco fallido deja estado='error' pero los
  -- datos del ok anterior siguen en las tablas y siguen siendo válidos: la API
  -- decide "mes con datos" por ok_en, no por estado.
  ok_en           TIMESTAMPTZ,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ventana_desde, ventana_hasta)
);

-- RLS sin policies, como el resto de public (migrations/010_rls_public.sql): anon
-- y authenticated no ven nada; la app entra como postgres (BYPASSRLS).
ALTER TABLE public.dd_linea           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_venta_agregado  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_ventana_control ENABLE ROW LEVEL SECURITY;
