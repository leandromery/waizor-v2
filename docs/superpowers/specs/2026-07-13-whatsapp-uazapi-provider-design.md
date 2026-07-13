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

### Phase 2 — implemented (2026-07-13)

Shipped: `uazapi-api.ts` (raw HTTP: send text/media/menu + instance
create/connect/status/disconnect + webhook config), `providers/uazapi.ts`
(adapter, wired into `getProvider`), `inbound/uazapi-normalize.ts`, the four
routes under `/api/whatsapp/uazapi/` (connect, status, disconnect, webhook),
and the Settings method-picker + `uazapi-connect.tsx` QR panel. Unit tests:
`uazapi-api`, `uazapi-normalize`, `providers/uazapi`, `providers/index`,
`uazapi-server`. `next build` + `tsc` clean.

**Deviations from the plan (deliberate):**
- **Server config is env-driven, not a user field.** `UAZAPI_SERVER_URL` +
  `UAZAPI_ADMIN_TOKEN` live in env (the admin token wouldn't match an
  arbitrary user-picked server anyway). The Settings UI is just a
  method-picker + Connect, no free-text server box. The resolved base URL is
  still persisted per-account on `uazapi_base_url`.
- **Media is stored as UAZAPI's `fileURL` verbatim** (public, ~2-day
  retention) — no proxy. Known limitation.
- **Webhook has no HMAC** — resolved by instance id + `excludeMessages`.

**Not done (follow-ups):** hiding the Templates/Broadcast UI for UAZAPI
accounts. The *backend* already rejects templates on UAZAPI
(send-message.ts capability guard) and broadcast is Meta-shaped, so nothing
breaks — those UI surfaces just aren't gated/hidden yet.

## Phase 2 — concrete UAZAPI API mapping

Source spec: `uazapiGO - WhatsApp API` v2.1.1 (local copy:
`~/Downloads/uazapi-openapi-spec.yaml`). Server: `https://{subdomain}.uazapi.com`.
Auth headers: `admintoken` (create instance) and `token` (all per-instance ops).

**Connection lifecycle**
- `POST /instance/create` (admintoken) → `{ instance: { id, token, status, qrcode } }`.
  Persist `uazapi_instance_id` = `instance.id`, encrypt `instance.token` →
  `uazapi_instance_token`.
- `POST /instance/connect` (token) → `{ instance: { qrcode, status, paircode } }`.
  `qrcode` is base64 to render.
- `GET /instance/status` (token) → `{ instance: { status, profileName, owner },
  status: { connected, loggedIn, jid } }`. status enum:
  `disconnected | connecting | connected | hibernated`.
- `POST /instance/disconnect` (token). `DELETE /instance` removes it.

**Outbound** (token) — all take `number` + optional `replyid` (→ contextMessageId):
- `POST /send/text` — `{ number, text }`.
- `POST /send/media` — `{ number, type: image|video|document|audio|ptt, file (URL or
  base64), text (caption), docName }`.
- `POST /send/menu` — `{ number, type: button|list, text, footerText, listButton,
  choices[] }`. **Correction (verified in spec):** `choices` DO carry a per-option
  stable id. Button item = `"title|id"`; list item = `"title|id|description"` and
  `"[Section]"` starts a section. So we encode our own button/row ids as `title|id`
  and get them back verbatim: on reply the selected id comes in `buttonOrListid`.
- Send response = `Message` schema + `{ response: { status, message } }`. Return
  `messageid` (original provider id) as our `messageId`.

**Inbound** — `POST /webhook` (token). **Correction:** the config `events` array uses
the PLURAL names (`events: ['messages','connection']`, `excludeMessages:
['wasSentByApi','isGroupYes']`); the *delivered* `WebhookEvent.event` field is the
SINGULAR enum (`message|status|presence|group|connection`). Simple mode: omit
`action`/`id` so UAZAPI manages one webhook per instance. Points UAZAPI at
`/api/whatsapp/uazapi/webhook`. Envelope `{ event, instance: <id>, data: <Message> }`.
Resolve the account by `instance` → `uazapi_instance_id`. `Message` → NormalizedInbound:

| NormalizedInbound | UAZAPI `Message` field |
|---|---|
| providerMessageId | `messageid` |
| fromPhone | `sender` (strip JID suffix, then normalizePhone) |
| contactName | `senderName` |
| timestampSeconds | `messageTimestamp` / 1000 (ms → s) |
| typeLabel / contentType | `messageType` (map to allowed set) |
| contentText | `text` |
| mediaUrl | `fileURL` (already a URL — no Meta-style download) |
| interactiveReplyId | `buttonOrListid` |
| replyToProviderMessageId | `quoted` |
| reaction | `reaction` (target id) + emoji from `text` |

**Must skip** inbound events where `fromMe === true` (our own echoed sends) or
`isGroup === true` (CRM is 1:1) — Meta's webhook never delivered these; the UAZAPI
normalizer/route must filter them before calling `processInboundMessage`.

**Resolved confirmations (verified against spec v2.1.1)**
- **ID format:** `Message.id` = internal `r+hex`; `Message.messageid` = the WhatsApp
  provider id. Outbound `replyid` takes the provider-id format (spec example
  `3EB0538DA65A59F6D8A251`). Decision: **store `messageid` in `messages.message_id`**
  (matches the Meta wamid convention), send `replyid` = that stored id, and map inbound
  `quoted` → `replyToProviderMessageId`. (Residual: `quoted`'s exact format isn't
  spelled out; we treat it as a provider id for lookup consistency with Meta.)
- **Connection shapes:** `POST /instance/create` (admintoken) → `{ instance: Instance,
  token }`; persist `instance.id` + encrypt `instance.token`. `POST /instance/connect`
  (token) → `{ instance: Instance }` with `instance.qrcode` (base64, `data:image/png…`)
  + `instance.paircode`. `GET /instance/status` (token) → `{ instance: Instance }` with
  `status` enum `disconnected|connecting|connected|hibernated`, `profileName`, `owner`.
- **Webhook auth:** no request signing is documented (`security: token:[]` only guards
  calls *to* UAZAPI). Decision: resolve the account by `instance` and **ignore (200)**
  any unknown instance; rely on the unguessable instance-scoped id + configure
  `excludeMessages: ['wasSentByApi']` to stop echo loops. (Known limitation — no HMAC.)
- **`fileURL`:** `/message/download`'s `return_link` returns a **public URL** (no token),
  so inbound `Message.fileURL` is publicly retrievable. Decision: **store `fileURL`
  directly** (no Meta-style proxy). Known limitation: UAZAPI storage retains media ~2
  days, after which the link 404s — acceptable for v1.
