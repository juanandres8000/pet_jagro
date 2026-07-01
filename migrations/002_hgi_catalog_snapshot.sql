-- Migración 002: snapshot cacheado del catálogo cruzado (Productos + stock).
-- Single-row (id = 1): el dashboard lee de aquí (<100ms) en vez de cruzar contra
-- HGINet (~12s) en cada carga. Patrón read-through con TTL.

CREATE TABLE IF NOT EXISTS hgi_catalog_snapshot (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  data          JSONB,        -- el Product[] cruzado, exactamente como lo consume la vista
  built_at      TIMESTAMPTZ,  -- cuándo se reconstruyó contra HGINet
  source_counts JSONB,        -- { productos, saldos, inventario:{disponible,fuente,aviso} }
  CONSTRAINT hgi_catalog_single_row CHECK (id = 1)
);

INSERT INTO hgi_catalog_snapshot (id, data, built_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
