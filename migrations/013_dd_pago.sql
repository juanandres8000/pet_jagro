-- Pagos del precio cero registrados a mano (Viviana / contabilidad), factura por
-- factura. Ver docs/DESCUENTOS.md § "Pagos confirmados".
--
-- El precio cero que Jotagro regala en una factura de venta lo devuelve el
-- laboratorio con producto (precio cero que llega en compras) o con notas
-- crédito. HGINet no dice qué factura de venta salda cada uno, así que aquí lo
-- registra una persona autorizada (lib/hgi/descuentos/permisos.ts).
--
-- La factura se identifica por (nit_proveedor, codigo_transaccion, documento),
-- las mismas columnas de dd_linea. No hay FK: dd_linea se sustituye por lotes en
-- cada ingesta y los pagos no deben borrarse con ella.
--
-- Nada se borra: anular deja anulado_en/anulado_por (auditoría).
-- Tabla NUEVA; no altera ninguna existente. Idempotente. DDL por 5432.

CREATE TABLE IF NOT EXISTS dd_pago (
  id                  BIGSERIAL     PRIMARY KEY,
  nit_proveedor       TEXT          NOT NULL,          -- laboratorio
  codigo_transaccion  TEXT          NOT NULL,          -- de la factura de venta
  documento           INTEGER       NOT NULL,
  fecha_pago          DATE          NOT NULL,
  forma               TEXT          NOT NULL CHECK (forma IN ('nota_credito', 'producto', 'otro')),
  valor               NUMERIC(18,2) NOT NULL CHECK (valor >= 0),
  -- La persona da la factura por saldada aunque el valor no llegue al costo
  -- (p. ej. el laboratorio repuso el producto y se valoró distinto).
  salda               BOOLEAN       NOT NULL DEFAULT FALSE,
  referencia          TEXT,                            -- nº nota crédito / factura de compra
  observacion         TEXT,
  registrado_por      TEXT          NOT NULL,          -- correo de la sesión
  registrado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  anulado_en          TIMESTAMPTZ,
  anulado_por         TEXT
);

CREATE INDEX IF NOT EXISTS dd_pago_factura_idx
  ON dd_pago (nit_proveedor, codigo_transaccion, documento)
  WHERE anulado_en IS NULL;

-- RLS sin policies, como el resto de public (migrations/010_rls_public.sql).
ALTER TABLE public.dd_pago ENABLE ROW LEVEL SECURITY;
