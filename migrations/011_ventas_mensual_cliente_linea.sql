-- Cliente × línea de producto en hgi_ventas_mensual, en venta NETA
-- (ValorTotalDetalle − ValorDescuentoDetalle), para la consulta por cliente del
-- apartado Comercial (/comercial).
--
-- Una entrada por (zona, NIT, línea) del mes: {zona, nit, nombre, linea, venta,
-- unidades, documentos}. La zona es la del vendedor (lib/hgi/zonas.ts), así un
-- cliente atendido por dos vendedores queda separado igual que en por_zona.
-- Excluye el NIT genérico de mostrador (22222222): Σ por_cliente_linea = venta
-- neta del mes − venta de mostrador.
--
-- Aditiva y nullable: NULL = "sin construir para esta dimensión" hasta que el
-- mes se reconstruya (scripts/rebuild-meses.ts). La tabla ya tiene RLS (010).
-- Idempotente.

ALTER TABLE hgi_ventas_mensual ADD COLUMN IF NOT EXISTS por_cliente_linea JSONB;
