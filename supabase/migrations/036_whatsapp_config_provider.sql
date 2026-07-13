-- ============================================================
-- whatsapp_config: multi-provider support (Meta + UAZAPI)
--
-- Why this exists:
--   Until now every whatsapp_config row was implicitly a Meta Cloud
--   API connection. We're adding a second provider — UAZAPI, an
--   unofficial session-based API that pairs by scanning a QR code.
--   A given account uses ONE provider at a time (the user picks it in
--   Settings), so we discriminate on a single `provider` column rather
--   than splitting into a second table.
--
--   Meta columns are left exactly as they are; a UAZAPI row simply
--   leaves them NULL and populates the uazapi_* columns instead. That
--   means `access_token` and `phone_number_id`, which were NOT NULL
--   for the Meta-only world, must become nullable — a UAZAPI row has
--   neither. Provider-conditional presence ("Meta rows need a token,
--   UAZAPI rows need an instance") is enforced in application code
--   rather than a brittle multi-branch CHECK.
--
-- Backfill: `provider` defaults to 'meta', so every existing row keeps
-- its exact current meaning with no data migration.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'uazapi')),
  -- UAZAPI connection (all nullable; only set when provider = 'uazapi')
  ADD COLUMN IF NOT EXISTS uazapi_base_url       TEXT,  -- per-server host, e.g. https://xxx.uazapi.com
  ADD COLUMN IF NOT EXISTS uazapi_instance_id    TEXT,  -- instance identifier on the UAZAPI server
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,  -- encrypted (same GCM helpers as access_token)
  ADD COLUMN IF NOT EXISTS uazapi_status         TEXT,  -- 'disconnected' | 'connecting' | 'connected'
  ADD COLUMN IF NOT EXISTS uazapi_wa_number      TEXT;  -- the paired phone number, once connected

-- A UAZAPI row has no Meta credentials. Relax the two NOT NULLs that
-- the Meta-only schema imposed; presence is validated per-provider in
-- the app layer.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token    DROP NOT NULL;

-- Inbound UAZAPI webhooks resolve the owning account by instance id,
-- the same way Meta inbound resolves by phone_number_id (migration 013).
-- Partial unique so multiple Meta rows (instance id NULL) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance
  ON whatsapp_config (uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;
