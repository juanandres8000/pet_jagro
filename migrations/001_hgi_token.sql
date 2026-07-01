-- Migración 001: caché compartido del token JWT de HGINet.
-- HGINet permite UN SOLO token vigente por usuario (~horas). Esta tabla es
-- single-row (id = 1 fijo) y actúa como candado/caché entre invocaciones
-- serverless (lambdas de Vercel no comparten memoria).

CREATE TABLE IF NOT EXISTS hgi_token (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  jwt        TEXT,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hgi_token_single_row CHECK (id = 1)
);

-- Sembrar la fila única (vacía) para poder hacer UPDATE/UPSERT sin condiciones.
INSERT INTO hgi_token (id, jwt, expires_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
