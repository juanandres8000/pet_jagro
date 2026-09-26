-- RLS en todo el esquema public, SIN policies.
--
-- Por qué: con Supabase Auth la app pasa a usar la anon key, y PostgREST expone
-- `public` a los roles anon/authenticated. Antes de esto las 8 tablas tenían RLS
-- apagado y `anon` con SELECT/INSERT sobre todas — incluida hgi_token, que guarda
-- el JWT de HGINet. Con RLS y ninguna policy, anon y authenticated no ven ni
-- escriben ninguna fila.
--
-- La app NO se ve afectada: se conecta por DATABASE_URL como `postgres`, que es
-- dueño de las tablas y tiene BYPASSRLS. No se usa FORCE ROW LEVEL SECURITY
-- justamente para que el dueño siga pasando.
--
-- Vistas: una vista corre con los privilegios de su DUEÑO (postgres, bypass), así
-- que anon leería pyg_movimiento a través de pyg_mensual aunque la tabla tenga
-- RLS. `security_invoker` (PG15+) hace que la vista aplique los permisos y RLS de
-- quien consulta. Para postgres no cambia nada.
--
-- ⚠️ Tablas nuevas: los stores crean tablas con CREATE TABLE IF NOT EXISTS y
-- nacen SIN RLS. Cualquier tabla nueva en public debe añadir su ENABLE ROW LEVEL
-- SECURITY (y cualquier vista nueva, security_invoker).
--
-- Idempotente.

ALTER TABLE public.chat_feedback        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hgi_catalog_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hgi_snapshot         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hgi_token            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hgi_ventas_mensual   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pyg_cuenta           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pyg_movimiento       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pyg_ventana_control  ENABLE ROW LEVEL SECURITY;

ALTER VIEW public.pyg_mensual      SET (security_invoker = true);
ALTER VIEW public.pyg_saldo_cuenta SET (security_invoker = true);
