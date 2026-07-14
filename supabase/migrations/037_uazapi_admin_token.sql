-- ============================================================
-- whatsapp_config: per-account UAZAPI server credentials
--
-- Phase 2 shipped with a single deployment-wide UAZAPI server (env
-- UAZAPI_SERVER_URL / UAZAPI_ADMIN_TOKEN). We're moving the server config
-- per-account: uazapi_base_url already exists (036); this adds the admin
-- token, stored encrypted with the same GCM helpers as access_token.
--
-- No backfill: no account has connected via UAZAPI yet.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_admin_token TEXT;  -- encrypted (GCM)
