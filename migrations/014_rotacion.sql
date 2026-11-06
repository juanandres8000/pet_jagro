-- Rotación de inventario (docs/ROTACION.md). Tablas NUEVAS; no altera ninguna.
--
--  rot_movimiento       Movimiento de inventario por ventana MENSUAL, bodega y
--                       producto, separado por grupo (compra, traslado, devolución,
--                       venta…). Unidades. Sale de Documentos/ObtenerDetalleReporte.
--  rot_saldo            Existencia actual por bodega y producto
--                       (Inventario/ObtenerInventario). Se reemplaza entera en cada toma.
--  rot_producto         Nombre y proveedor de cada producto (de las líneas de HGI).
--  rot_ventana_control  Cursor e historial de la ingesta (mismo esquema que dd_).
--
-- Inicial y final de un periodo NO se guardan: se calculan hacia atrás desde el
-- saldo actual (final = saldo − movimiento posterior; inicial = final − periodo).
-- Por eso hacen falta todos los meses desde el inicio del periodo hasta hoy.
--
-- Idempotente. DDL por sesión (5432), no por el pooler.

CREATE TABLE IF NOT EXISTS rot_movimiento (
  ventana_desde   DATE          NOT NULL,
  ventana_hasta   DATE          NOT NULL,
  mes             TEXT          NOT NULL,             -- 'YYYY-MM'
  bodega          TEXT          NOT NULL,
  codigo_producto TEXT          NOT NULL,
  ent_compra      NUMERIC(14,2) NOT NULL DEFAULT 0,
  ent_traslado    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ent_devolucion  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ent_otras       NUMERIC(14,2) NOT NULL DEFAULT 0,
  sal_venta       NUMERIC(14,2) NOT NULL DEFAULT 0,
  sal_traslado    NUMERIC(14,2) NOT NULL DEFAULT 0,
  sal_otras       NUMERIC(14,2) NOT NULL DEFAULT 0,
  lineas          INTEGER       NOT NULL DEFAULT 0,
  lote            UUID          NOT NULL,
  PRIMARY KEY (ventana_desde, ventana_hasta, bodega, codigo_producto)
);
CREATE INDEX IF NOT EXISTS rot_movimiento_mes_idx ON rot_movimiento (mes, bodega);

CREATE TABLE IF NOT EXISTS rot_saldo (
  bodega          TEXT          NOT NULL,
  codigo_producto TEXT          NOT NULL,
  cantidad        NUMERIC(14,2) NOT NULL DEFAULT 0,
  costo_unitario  NUMERIC(18,2) NOT NULL DEFAULT 0,  -- promedio ponderado de lotes > 0
  tomado_en       TIMESTAMPTZ   NOT NULL,
  PRIMARY KEY (bodega, codigo_producto)
);

CREATE TABLE IF NOT EXISTS rot_producto (
  codigo_producto  TEXT PRIMARY KEY,
  nombre           TEXT NOT NULL,
  nit_proveedor    TEXT,
  nombre_proveedor TEXT,
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rot_ventana_control (
  ventana_desde   DATE NOT NULL,
  ventana_hasta   DATE NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|ok|error
  lineas          INTEGER NOT NULL DEFAULT 0,          -- líneas leídas de HGINet
  filas           INTEGER NOT NULL DEFAULT 0,          -- filas escritas en rot_movimiento
  duracion_ms     INTEGER NOT NULL DEFAULT 0,
  intentos        SMALLINT NOT NULL DEFAULT 0,
  ultimo_error    TEXT,
  lote            UUID,
  ok_en           TIMESTAMPTZ,                         -- última ingesta EXITOSA
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ventana_desde, ventana_hasta)
);

-- RLS sin policies, como el resto de public (migrations/010_rls_public.sql).
ALTER TABLE public.rot_movimiento      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rot_saldo           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rot_producto        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rot_ventana_control ENABLE ROW LEVEL SECURITY;
