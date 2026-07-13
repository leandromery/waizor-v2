# Multi-provider WhatsApp: Meta (official) + UAZAPI (unofficial, QR)

**Date:** 2026-07-13
**Status:** Approved — foundation implementable now; UAZAPI adapter internals pending vendor docs.

## Goal

Add a second way to connect WhatsApp — **UAZAPI** (unofficial, session-based, connects by scanning a QR code) — alongside the existing **Meta Cloud API** integration, without regressing the Meta path. The user picks the active provider in Settings. One provider active per account at a time.

## Scope decisions (agreed)

- **One provider per account at a time.** A `provider` discriminator on the single `whatsapp_config` row; switching providers is an explicit reconfiguration.
- **UAZAPI v1 feature set:** text + media + interactive (buttons/lists) if UAZAPI supports it. **No** Meta templates (a Meta-only concept). Broadcast for UAZAPI is out of v1.

## Current Meta coupling (baseline)

1. **Storage** — `whatsapp_config`, one row per account (`UNIQUE(user_id)`; also has `account_id` since migration 017, `user_id` = audit/sender-of-record). Meta columns: `phone_number_id`, `waba_id`, `access_token` (encrypted), `verify_token`, registration state.
2. **Outbound** — `send-message.ts › sendMessageToConversation()` loads config, decrypts the token, and calls `meta-api.ts` directly. Also `flows/meta-send.ts` and `automations/meta-send.ts` call `meta-api.ts` directly.
3. **Inbound** — `/api/whatsapp/webhook/route.ts` (~1,079 lines): Meta signature verify, resolve account by `phone_number_id`, download media via Meta API. The provider-agnostic core is `processMessage(message, contact, accountId, userId, accessToken)`.
4. **Templates** — a whole subsystem (approval lifecycle, WABA sync), inherently Meta.

## Architecture: Provider adapter interface (Approach A)

New `src/lib/whatsapp/providers/`:

```ts
interface WhatsAppProvider {
  readonly id: 'meta' | 'uazapi'
  sendText(ctx, { to, text, replyTo? }): Promise<{ messageId: string }>
  sendMedia(ctx, { to, kind, link, caption?, filename?, replyTo? }): Promise<{ messageId: string }>
  sendInteractive(ctx, { to, payload, replyTo? }): Promise<{ messageId: string }>
  capabilities: { templates: boolean; interactive: boolean; broadcast: boolean }
  normalizeInbound(rawBody): Promise<NormalizedInbound[]>   // resolves media too
  connect?(ctx): Promise<{ qrCode?: string; status: string }>
  getStatus?(ctx): Promise<{ status: string; waNumber?: string }>
}
```

- `providers/meta.ts` — wraps existing `meta-api.ts` verbatim; `capabilities = {templates,interactive,broadcast: all true}`.
- `providers/uazapi.ts` — new; internals from vendor docs.
- `providers/index.ts` — `getProvider(config)` picks by `config.provider`.

## 1. Data model

Migration `03X_whatsapp_config_provider.sql`:

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta','uazapi')),
  ADD COLUMN IF NOT EXISTS uazapi_base_url       TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_id    TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,   -- encrypted
  ADD COLUMN IF NOT EXISTS uazapi_status         TEXT,   -- disconnected|connecting|connected
  ADD COLUMN IF NOT EXISTS uazapi_wa_number      TEXT;

-- inbound resolves the account by instance id
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance
  ON whatsapp_config (uazapi_instance_id) WHERE uazapi_instance_id IS NOT NULL;
```

- **Trade-off (accepted):** relax `access_token` / `phone_number_id` to nullable (a UAZAPI row has neither), enforcing provider-conditional presence in application code rather than a brittle multi-branch CHECK. Existing rows default `provider='meta'` and are otherwise untouched.
- `uazapi_instance_token` uses the existing `encrypt()`/`decrypt()` (GCM) helpers.

## 2. Outbound path

- `sendMessageToConversation()`: after loading config, `const provider = getProvider(config)`; replace the inline `attempt()` dispatch with `provider.sendText/sendMedia/sendInteractive`. Meta provider keeps the current phone-variant retry + `contextMessageId` behavior verbatim.
- Guard templates: if `messageType === 'template'` and `!provider.capabilities.templates`, throw `SendMessageError('unsupported_for_provider', ...)`.
- `flows/meta-send.ts` + `automations/meta-send.ts` route through the provider (rename to provider-neutral senders; behavior preserved for Meta).

## 3. Inbound path (the one real refactor)

- Extract provider-agnostic core into `src/lib/whatsapp/inbound/process.ts` as `processInbound(normalized, { accountId, userId, provider })` — contact dedupe, conversation resolution, flows/automations/AI-reply dispatch, webhook fan-out, status ladder — all reused unchanged.
- Media download (currently Meta `getMediaUrl`/`downloadMedia` inline) moves behind the provider: `normalizeInbound` returns media already resolved to a storable URL/bytes.
- `/api/whatsapp/webhook/route.ts` (Meta) keeps its path/signature/shape; only its inner loop is extracted (behavior-preserving).
- New `/api/whatsapp/uazapi/webhook/route.ts`: authenticate UAZAPI callback → `normalizeInbound` → resolve account by `uazapi_instance_id` → `processInbound(...)`.

## 4. Connection / QR flow (UAZAPI-only)

New routes under `/api/whatsapp/uazapi/`:
- `POST /connect` — init instance, store `uazapi_instance_id` + encrypted token, return `{ qrCode, status }`.
- `GET /status` — poll; on pair, persist `uazapi_status='connected'` + `uazapi_wa_number`, and point UAZAPI's webhook at our inbound route.
- `POST /disconnect` — log the instance out.

QR is short-lived; the UI polls `/status` and refreshes the QR on expiry until `connected`.

## 5. Settings UI

`whatsapp-config.tsx`: a provider selector (Meta | UAZAPI) swaps the panel body. Meta = existing form unchanged. UAZAPI = server/base-url field + "Conectar" → QR image + live status badge + "Desconectar". Switching the active provider is a confirmed action.

## 6. Feature gating

Driven by `provider.capabilities`, not scattered `if`s. Templates subsystem + broadcast UI hidden/disabled for UAZAPI. Interactive shown for both. Send API rejects unsupported types with a clear message.

## 7. Testing

- Unit: `providers/uazapi.ts` send + `normalizeInbound` (fixtures), mirroring `meta-api.test.ts` style.
- Contract: both providers' normalized output flows identically through `processInbound`.
- Regression gate: all existing Meta tests pass unchanged.
- Gating: send-message rejects template on UAZAPI.

## 8. Non-breaking guarantees

1. Meta columns + `phone_number_id UNIQUE` untouched; existing rows default `provider='meta'`.
2. Meta provider methods wrap current `meta-api.ts` calls verbatim.
3. Meta webhook route keeps path/signature/shape; only inner loop extracted.
4. Existing Meta tests are the green gate.

## Phasing

- **Phase 1 (no vendor docs needed):** migration, provider interface + registry, Meta wrapper, outbound routing, inbound-core extraction, settings selector + gating. Carries all the "don't break Meta" risk.
- **Phase 2 (needs UAZAPI docs):** `providers/uazapi.ts` internals, connect/QR/status routes, UAZAPI webhook, UAZAPI QR UI.

## Open items — need UAZAPI docs before Phase 2

- Endpoints/fields for: instance create + QR, status polling, send text, send media, send interactive (and whether interactive is supported at all).
- Inbound webhook payload shape + how it authenticates callbacks to us.
- Media delivery form (hosted URL vs base64) → dictates §3 media resolution.
