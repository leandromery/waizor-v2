# UAZAPI server config per account (not deployment-wide env)

**Date:** 2026-07-14
**Status:** Approved — design agreed, ready for implementation plan.

## Goal

Let **each company (account) configure its own UAZAPI server** — base URL +
admin token — instead of the single deployment-wide server currently read
from env (`UAZAPI_SERVER_URL` / `UAZAPI_ADMIN_TOKEN`). Every account brings
its own UAZAPI subscription; nothing is shared across tenants.

## Context

Phase 2 (see `2026-07-13-whatsapp-uazapi-provider-design.md`) shipped with a
deployment-level UAZAPI server: `resolveUazapiServer()` reads the base URL +
admin token from env, and each account's instance is minted from that one
shared server. This change makes the server per-account.

**No data migration needed:** no account has connected via UAZAPI yet, so we
change the behavior cleanly rather than preserving existing rows.

## Scope decisions (agreed)

- **Pure per-account, no env fallback.** An account must save its own server
  URL + admin token to connect. The env vars are removed.
- **Single "Save & Connect".** The UAZAPI panel has Server URL + Admin Token
  fields and one button that persists (token encrypted) and starts the QR.
  Reconnects reuse the stored values.
- **Admin token stored encrypted** (`uazapi_admin_token`, GCM helpers), so
  reconnect / reset / re-mint don't require re-typing it.

## 1. Data model

Migration `037_uazapi_admin_token.sql`:

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_admin_token TEXT;  -- encrypted (GCM), per-account
```

- `uazapi_base_url` already exists (migration 036).
- `uazapi_admin_token` is encrypted with the existing `encrypt()`/`decrypt()`
  helpers, same as `access_token` / `uazapi_instance_token`.
- Existing RLS on `whatsapp_config` already gates insert/update to
  `is_account_member(account_id, 'admin')`.

## 2. Backend — connect route becomes per-account

`POST /api/whatsapp/uazapi/connect` accepts an optional `{ baseUrl, adminToken }`
body:

- **First time / changing server:** body carries `baseUrl` + `adminToken`.
  Validate (base URL is a valid `https://` URL; admin token non-empty),
  normalize the URL (strip trailing slash), persist `uazapi_base_url` +
  encrypted `uazapi_admin_token`, then mint the instance with that admin
  token, store instance id + encrypted instance token, configure the
  webhook, connect → return QR.
- **Reconnect / QR refresh:** body omits credentials → read stored
  `uazapi_base_url` + decrypt stored `uazapi_admin_token`.
- **Nothing stored and nothing in body:** `400` — "Configure this account's
  UAZAPI server first."
- **Remove** `resolveUazapiServer()` and the `UAZAPI_SERVER_URL` /
  `UAZAPI_ADMIN_TOKEN` env vars (from `.env.production.example` and the
  server `.env`). `uazapiWebhookUrl()` stays — it builds OUR callback URL
  from `NEXT_PUBLIC_SITE_URL`, unrelated to the UAZAPI server.
- `connect` and `disconnect` require `requireRole('admin')` (they mutate
  config); `status` stays any-member. (RLS already enforces admin on the
  DB write; the role check just turns an RLS failure into a clean 403.)

### Validation helper (testable, pure)

`normalizeUazapiBaseUrl(input): string` — trims, requires `https://`, strips
trailing slashes, throws a clear error otherwise. Unit-tested. This replaces
the env-parsing half of `uazapi-server.ts`; `uazapiWebhookUrl` moves/stays
alongside it.

## 3. UI — panel gains the fields

`uazapi-connect.tsx`:

- Two inputs — **Server URL** (`https://…uazapi.com`) and **Admin Token**
  (password-masked; shows the `MASKED_TOKEN` placeholder when a token is
  already saved, mirroring the Meta form so we never round-trip the secret
  to the browser).
- **"Save & Connect"** posts `{ baseUrl, adminToken }`, omitting `adminToken`
  when it's still the mask (→ backend uses the stored one). On success it
  renders the QR and begins polling, exactly as today.
- When connected: show the server URL + paired number + **Disconnect**, with
  an affordance to edit the server (which returns to the fields).

## 4. Testing

- **Unit:** `normalizeUazapiBaseUrl` (valid/invalid/normalization cases).
  Keep `uazapiWebhookUrl` tests; drop the `resolveUazapiServer` (env) tests.
- **Routes** follow the repo convention (thin glue, covered by `tsc` +
  `next build`); the credential-resolution branching is exercised through the
  pure validation helper.
- **Regression gate:** existing whatsapp + provider tests stay green; the
  Meta path is untouched.

## 5. Non-goals (YAGNI)

- No env fallback / hybrid mode.
- No multiple UAZAPI servers per account (still one server, one instance).
- No platform-admin-only variant — the account's own admins configure it.

## Deployment note

After this ships, `UAZAPI_SERVER_URL` / `UAZAPI_ADMIN_TOKEN` in
`/opt/waizor-v2/.env` become dead config and can be removed. Migration 037
must be applied to Supabase (like 036) before the feature works.
