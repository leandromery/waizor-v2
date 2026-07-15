# UAZAPI integration notes

Reference for the UAZAPI (unofficial, QR-paired WhatsApp) provider. Captures
how it works in this codebase and the real-world gotchas found wiring it up
(the vendor's live behavior diverges from its OpenAPI spec in several places).

Status: **live in production since 2026-07-14** — QR connect, inbound
text/audio/image, voice-note send, image lightbox.

## Architecture

- Provider seam: `src/lib/whatsapp/providers/` (`getProvider(config)` →
  `meta` | `uazapi`). One provider active per account (`whatsapp_config.provider`).
- Raw HTTP: `src/lib/whatsapp/uazapi-api.ts`.
- Inbound: `src/app/api/whatsapp/uazapi/webhook/route.ts` +
  `src/lib/whatsapp/inbound/uazapi-normalize.ts` → shared
  `inbound/process.ts` (same processor as Meta).
- Connect/QR/status/disconnect: `src/app/api/whatsapp/uazapi/{connect,status,disconnect}/route.ts`.
- Settings UI: `src/components/settings/uazapi-connect.tsx` (+ the method
  picker in `whatsapp-config.tsx`).
- Migrations: `036_whatsapp_config_provider.sql` (provider + `uazapi_*`),
  `037_uazapi_admin_token.sql` (`uazapi_admin_token`). Both must be applied
  to Supabase manually — `deploy.sh` does not run migrations.

## Per-account server config

The UAZAPI server (base URL + admin token) is configured **per account**, not
via deployment env. Each company saves its own in Settings:

- `uazapi_base_url` — the server, e.g. `https://<sub>.uazapi.com`.
- `uazapi_admin_token` — **server-level** `admintoken` that mints instances
  (distinct from the per-instance `token`). Stored encrypted (GCM).
- `normalizeUazapiBaseUrl` validates https + rejects private/loopback/
  link-local hosts (SSRF hardening — literal-address check, no DNS).

The connect route mints an instance named `waizor-<accountId>`, stores its id
+ encrypted token, points UAZAPI's webhook at us, and returns the QR.

## Gotchas (all handled in code — read before changing these paths)

1. **Webhook `enabled` defaults to `false`.** `configureWebhook` MUST send
   `enabled: true`, or UAZAPI registers a disabled webhook that silently
   delivers nothing.

2. **The real webhook envelope ≠ the spec.** UAZAPI sends
   `{ EventType, instanceName, message, chat, owner, token, ... }`, NOT the
   spec's `{ event, instance, data }`. Specifically:
   - Event type field is `EventType`; a message event is `"messages"` (plural).
   - The message object is in `message` (not `data`).
   - There is **no instance id** on a message event — resolve the account by
     parsing `instanceName` (`waizor-<accountId>`).

3. **Phone number vs LID.** `message.sender` is a LID (`…@lid`) — NOT a phone.
   The real phone is in `sender_pn` / `chatid` (`…@s.whatsapp.net`).

4. **Empty strings, not null.** Optional fields (`quoted`, `reaction`,
   `buttonOrListid`) arrive as `""`. Coerce to null.

5. **Inbound media is encrypted.** The webhook only carries an encrypted
   WhatsApp CDN URL (`content.URL`, `.enc` + `mediaKey`) — not playable.
   Resolve a usable public URL via `POST /message/download` (`return_link`);
   the normalizer takes a `resolveMedia` callback the webhook route supplies.
   Media type lives in `message.mediaType` / `messageType` (`type` is just
   `"media"`). UAZAPI storage retains the resolved URL ~2 days.

6. **Return 4xx, not 5xx, for user-facing errors.** Cloudflare (in front of
   the app) swallows 5xx response bodies, so a 502 hides the real UAZAPI
   error from the client toast. Rejected admin token / bad server → 400.

7. **No Meta 24h window.** UAZAPI has no customer-service window. The inbox
   passes `enforceSessionWindow={false}` so the composer is never locked by
   session expiry; the "not connected" banner checks `uazapi_status`.

## Deploy

`./deploy.sh` on the VPS (`/opt/waizor-v2`, branch `main`) builds the image
and force-rolls the Swarm service (the `:latest` tag alone won't trigger a
rollout — see [the deploy memory / DEPLOY.md]).

## Known follow-up (F2)

Changing only the server URL while leaving the admin-token field masked
silently reuses the previously stored server (the connect route only takes
body creds when both baseUrl and adminToken are present). Consider returning
a 400 asking for the token when the URL changes.
