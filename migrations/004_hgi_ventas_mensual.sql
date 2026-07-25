-- Agregados mensuales de ventas: UNA fila por mes.
--
-- Por qué tabla propia y no un dataset de hgi_snapshot: el backfill escribe UN
-- mes por corrida de cron y debe conservar los demás. Sobre hgi_snapshot eso
-- sería un read-modify-write del array JSONB completo, y dos crons concurrentes
-- se pisarían el trabajo. Con una fila por mes el ON CONFLICT (mes) es un upsert
-- atómico: cada corrida sólo toca su mes.
--
-- Idempotente (IF NOT EXISTS), igual que 001-003. También se crea init-on-use
-- desde lib/hgi/ventasMensualStore.ts.

CREATE TABLE IF NOT EXISTS hgi_ventas_mensual (
  mes           TEXT PRIMARY KEY,
  venta         DOUBLE PRECISION NOT NULL DEFAULT 0,
  costo         DOUBLE PRECISION NOT NULL DEFAULT 0,
  margen        DOUBLE PRECISION NOT NULL DEFAULT 0,
  iva           DOUBLE PRECISION NOT NULL DEFAULT 0,
  descuento     DOUBLE PRECISION NOT NULL DEFAULT 0,
  lineas        INTEGER NOT NULL DEFAULT 0,
  documentos    INTEGER NOT NULL DEFAULT 0,
  -- NITs distintos del mes. Se guarda la lista, no sólo el conteo, para poder
  -- calcular "clientes activos del año" como UNIÓN de los meses: sumar los
  -- conteos mensuales cuenta varias veces al cliente que compra todos los meses.
  clientes_nits JSONB,
  top_clientes  JSONB,
  top_productos JSONB,
  por_linea     JSONB,
  por_vendedor  JSONB,
  -- Cierre del rango realmente consultado. Para el mes en curso es el día de
  -- hoy, así que el mes queda "parcial" y se refresca en cada corrida.
  hasta         TEXT,
  parcial       BOOLEAN NOT NULL DEFAULT FALSE,
  built_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
