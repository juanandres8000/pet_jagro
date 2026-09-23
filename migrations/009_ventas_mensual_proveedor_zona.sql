-- Dos rankings nuevos en hgi_ventas_mensual, en venta NETA (ValorTotalDetalle −
-- ValorDescuentoDetalle):
--
--  - por_proveedor: todos los proveedores del mes (NitProveedor de la línea de
--    ObtenerDetalleReporte), con la forma de por_linea/por_vendedor.
--  - por_zona: una entrada por ciudad del cliente (NombreCiudadTercero) con la
--    lista COMPLETA de sus clientes, no un top-N: el pareto la necesita entera.
--    "Zona" es la ciudad porque NombreZonaTercero viene "GENERAL" en todas las
--    líneas y el maestro de terceros no trae zona.
--
-- Aditiva y nullable: las filas existentes quedan en NULL ("sin construir para
-- esta dimensión") hasta que su mes se reconstruya. Idempotente.

ALTER TABLE hgi_ventas_mensual ADD COLUMN IF NOT EXISTS por_proveedor JSONB;
ALTER TABLE hgi_ventas_mensual ADD COLUMN IF NOT EXISTS por_zona      JSONB;
