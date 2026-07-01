-- Migración 003: snapshot read-through GENERALIZADO por dataset.
-- Sustituye a hgi_catalog_snapshot (002) por una tabla keyed-by-dataset, para
-- cachear varios datasets (catálogo, clientes, …) con el mismo patrón.
-- La tabla 002 queda huérfana (inofensiva); puede dropearse manualmente.

CREATE TABLE IF NOT EXISTS hgi_snapshot (
  dataset       TEXT PRIMARY KEY,          -- 'catalog' | 'clients' | …
  data          JSONB,                     -- el array de DTOs, tal cual lo consume la vista
  built_at      TIMESTAMPTZ,
  source_counts JSONB                      -- metadata de fuentes (conteos, disponibilidad, etc.)
);
