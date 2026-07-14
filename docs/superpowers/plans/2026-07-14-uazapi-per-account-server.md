# UAZAPI Per-Account Server Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each account configure its own UAZAPI server (base URL + admin token) in Settings, replacing the deployment-wide env vars.

**Architecture:** Add an encrypted `uazapi_admin_token` column; the connect route reads server credentials from the request body (first time / change) or the stored row (reconnect), instead of env. The Settings panel gains Server URL + Admin Token fields behind a single "Save & Connect". Pure per-account — no env fallback.

**Tech Stack:** Next.js (App Router) API routes, Supabase (Postgres + RLS), Vitest, TypeScript, AES-256-GCM (`encrypt`/`decrypt`).

## Global Constraints

- Run all commands from the project root: `/Users/leandromery/Documents/Clientes/Twin/Waizor/waizor-v2/waizor-v2`.
- Test runner: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit` (must stay 0 errors).
- Encrypt every secret before persisting with `encrypt()` from `@/lib/whatsapp/encryption`; decrypt on read with `decrypt()`.
- Never round-trip a stored secret to the browser — mask with the existing `MASKED_TOKEN` pattern.
- Follow the repo convention: lib helpers are unit-tested; API route handlers are thin glue verified by `tsc` + `next build`.
- The Meta path must stay byte-for-byte unchanged.
- Migration files are numbered sequentially; the next free number is `037`.

---

### Task 1: Migration 037 + config type

**Files:**
- Create: `supabase/migrations/037_uazapi_admin_token.sql`
- Modify: `src/types/index.ts` (WhatsAppConfig interface — add `uazapi_admin_token`)

**Interfaces:**
- Produces: `whatsapp_config.uazapi_admin_token` (TEXT, encrypted); TS field `uazapi_admin_token?: string` on `WhatsAppConfig`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/037_uazapi_admin_token.sql`:

```sql
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
```

- [ ] **Step 2: Add the field to the WhatsAppConfig type**

In `src/types/index.ts`, find the `uazapi_instance_token?` line in the `WhatsAppConfig` interface and add directly after it:

```typescript
  /** UAZAPI server admin token, encrypted (per-account, mints instances). */
  uazapi_admin_token?: string;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/037_uazapi_admin_token.sql src/types/index.ts
git commit -m "feat(whatsapp): add per-account uazapi_admin_token column"
```

---

### Task 2: Replace env server resolution with a base-URL validator

**Files:**
- Modify: `src/lib/whatsapp/uazapi-server.ts` (remove `resolveUazapiServer` + `UazapiServer`; add `normalizeUazapiBaseUrl`; keep `uazapiWebhookUrl`)
- Modify: `src/lib/whatsapp/uazapi-server.test.ts` (drop env tests; add validator tests)

**Interfaces:**
- Produces: `normalizeUazapiBaseUrl(input: string): string` — trims, requires `https://`, strips trailing slashes, throws `Error` with a clear message otherwise.
- Keeps: `uazapiWebhookUrl(siteUrl: string): string`.
- Removes: `resolveUazapiServer()`, `UazapiServer` (consumers updated in Task 3).

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `src/lib/whatsapp/uazapi-server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeUazapiBaseUrl, uazapiWebhookUrl } from "./uazapi-server";

describe("normalizeUazapiBaseUrl", () => {
  it("trims and strips a trailing slash", () => {
    expect(normalizeUazapiBaseUrl("  https://x.uazapi.com/  ")).toBe("https://x.uazapi.com");
  });

  it("keeps a path-less https url unchanged", () => {
    expect(normalizeUazapiBaseUrl("https://x.uazapi.com")).toBe("https://x.uazapi.com");
  });

  it("rejects an empty value", () => {
    expect(() => normalizeUazapiBaseUrl("")).toThrow(/required/i);
  });

  it("rejects a non-https url", () => {
    expect(() => normalizeUazapiBaseUrl("http://x.uazapi.com")).toThrow(/https/i);
  });

  it("rejects a non-url string", () => {
    expect(() => normalizeUazapiBaseUrl("not a url")).toThrow(/valid/i);
  });
});

describe("uazapiWebhookUrl", () => {
  it("builds the inbound webhook url, collapsing a trailing slash", () => {
    expect(uazapiWebhookUrl("https://v2.waizor.com.br/")).toBe(
      "https://v2.waizor.com.br/api/whatsapp/uazapi/webhook",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-server.test.ts`
Expected: FAIL — `normalizeUazapiBaseUrl` is not exported.

- [ ] **Step 3: Rewrite the module**

Replace the entire contents of `src/lib/whatsapp/uazapi-server.ts`:

```typescript
/**
 * UAZAPI server helpers.
 *
 * The UAZAPI server (base URL + admin token) is configured per-account
 * now, not via deployment env — so the credential resolution lives in the
 * connect route against the account's whatsapp_config row. This module
 * keeps two pure helpers: validating a user-entered base URL, and building
 * OUR inbound webhook callback URL.
 */

/**
 * Normalize a user-entered UAZAPI base URL: trim, require an https URL,
 * strip trailing slashes. Throws a user-actionable Error otherwise.
 */
export function normalizeUazapiBaseUrl(input: string): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) {
    throw new Error('UAZAPI server URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('UAZAPI server URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('UAZAPI server URL must start with https://.');
  }
  return trimmed.replace(/\/+$/, '');
}

/** Build the inbound webhook callback URL UAZAPI should POST events to. */
export function uazapiWebhookUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-server.ts src/lib/whatsapp/uazapi-server.test.ts
git commit -m "refactor(whatsapp): replace env server resolution with base-url validator"
```

---

### Task 3: Connect route — per-account credentials + admin role

**Files:**
- Modify: `src/app/api/whatsapp/uazapi/connect/route.ts` (full rewrite of the handler)

**Interfaces:**
- Consumes: `normalizeUazapiBaseUrl`, `uazapiWebhookUrl` (Task 2); `createInstance`, `connectInstance`, `configureWebhook` (`@/lib/whatsapp/uazapi-api`); `encrypt`, `decrypt` (`@/lib/whatsapp/encryption`); `requireRole`, `toErrorResponse` (`@/lib/auth/account`).
- Request body: `{ baseUrl?: string, adminToken?: string }`.
- Response: `{ qrCode: string | null, paircode: string | null, status: string }` or `{ error }`.

- [ ] **Step 1: Rewrite the connect route**

Replace the entire contents of `src/app/api/whatsapp/uazapi/connect/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { normalizeUazapiBaseUrl, uazapiWebhookUrl } from '@/lib/whatsapp/uazapi-server'
import {
  createInstance,
  connectInstance,
  configureWebhook,
} from '@/lib/whatsapp/uazapi-api'

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Starts (or refreshes) a UAZAPI QR pairing for the caller's account. The
 * UAZAPI server (base URL + admin token) is configured per-account:
 *
 *  - Body carries `{ baseUrl, adminToken }` on first setup or when the
 *    account changes its server → validate, persist (token encrypted),
 *    mint a fresh instance.
 *  - Body omits them on a reconnect / QR refresh → use the stored server
 *    URL + decrypted admin token.
 *  - Neither present → 400 (server not configured yet).
 *
 * Admin-only (mutates whatsapp_config).
 *
 * Response: { qrCode, paircode, status }
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { supabase, accountId, userId } = ctx

  const body = await request.json().catch(() => ({}))
  const bodyBaseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const bodyAdminToken =
    typeof body?.adminToken === 'string' ? body.adminToken.trim() : ''

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin
  const webhookUrl = uazapiWebhookUrl(siteUrl)

  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select(
      'id, uazapi_base_url, uazapi_admin_token, uazapi_instance_id, uazapi_instance_token',
    )
    .eq('account_id', accountId)
    .maybeSingle()

  // Resolve server credentials: a full body (url + token) wins and can
  // change the server; otherwise fall back to the stored, encrypted pair.
  let baseUrl: string
  let adminToken: string
  if (bodyBaseUrl && bodyAdminToken) {
    try {
      baseUrl = normalizeUazapiBaseUrl(bodyBaseUrl)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid UAZAPI server URL.' },
        { status: 400 },
      )
    }
    adminToken = bodyAdminToken
  } else if (existing?.uazapi_base_url && existing?.uazapi_admin_token) {
    baseUrl = existing.uazapi_base_url
    adminToken = decrypt(existing.uazapi_admin_token)
  } else {
    return NextResponse.json(
      { error: "Configure this account's UAZAPI server (base URL + admin token) first." },
      { status: 400 },
    )
  }

  // Mint a new instance on first setup or when the server changed;
  // otherwise reuse the stored instance and just refresh its QR.
  const serverChanged =
    !!bodyBaseUrl &&
    !!existing?.uazapi_base_url &&
    existing.uazapi_base_url !== baseUrl
  let instanceId: string
  let instanceToken: string
  if (
    !serverChanged &&
    existing?.uazapi_instance_id &&
    existing?.uazapi_instance_token
  ) {
    instanceId = existing.uazapi_instance_id
    instanceToken = decrypt(existing.uazapi_instance_token)
  } else {
    const inst = await createInstance({
      baseUrl,
      adminToken,
      name: `waizor-${accountId}`,
    })
    if (!inst.token) {
      return NextResponse.json(
        { error: 'UAZAPI did not return an instance token.' },
        { status: 502 },
      )
    }
    instanceId = inst.id
    instanceToken = inst.token
  }

  // Persist provider switch + server creds + instance (secrets encrypted).
  const row = {
    provider: 'uazapi',
    uazapi_base_url: baseUrl,
    uazapi_admin_token: encrypt(adminToken),
    uazapi_instance_id: instanceId,
    uazapi_instance_token: encrypt(instanceToken),
    uazapi_status: 'connecting',
    updated_at: new Date().toISOString(),
  }
  if (existing) {
    const { error } = await supabase
      .from('whatsapp_config')
      .update(row)
      .eq('account_id', accountId)
    if (error) {
      console.error('[uazapi/connect] update failed:', error)
      return NextResponse.json({ error: 'Failed to save UAZAPI config.' }, { status: 500 })
    }
  } else {
    const { error } = await supabase
      .from('whatsapp_config')
      .insert({ account_id: accountId, user_id: userId, ...row })
    if (error) {
      console.error('[uazapi/connect] insert failed:', error)
      return NextResponse.json({ error: 'Failed to save UAZAPI config.' }, { status: 500 })
    }
  }

  // Point UAZAPI at our inbound webhook (best-effort — QR still works).
  try {
    await configureWebhook({
      baseUrl,
      token: instanceToken,
      url: webhookUrl,
      events: ['messages', 'connection'],
      excludeMessages: ['wasSentByApi'],
    })
  } catch (err) {
    console.warn(
      '[uazapi/connect] webhook configuration failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const connected = await connectInstance({ baseUrl, token: instanceToken })
  return NextResponse.json({
    qrCode: connected.qrcode ?? null,
    paircode: connected.paircode ?? null,
    status: connected.status,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/whatsapp/uazapi/connect/route.ts
git commit -m "feat(whatsapp): resolve UAZAPI server per-account in connect route"
```

---

### Task 4: Disconnect route — admin role

**Files:**
- Modify: `src/app/api/whatsapp/uazapi/disconnect/route.ts` (swap `getCurrentAccount` → `requireRole('admin')`)

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` (`@/lib/auth/account`).

- [ ] **Step 1: Gate on admin**

In `src/app/api/whatsapp/uazapi/disconnect/route.ts`:

Change the import line:
```typescript
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
```
to:
```typescript
import { requireRole, toErrorResponse } from '@/lib/auth/account'
```

Change the resolution line inside `POST`:
```typescript
    const { supabase, accountId } = await getCurrentAccount()
```
to:
```typescript
    const { supabase, accountId } = await requireRole('admin')
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/whatsapp/uazapi/disconnect/route.ts
git commit -m "feat(whatsapp): require admin role to disconnect UAZAPI"
```

---

### Task 5: Settings UI — server URL + admin token fields

**Files:**
- Modify: `src/components/settings/uazapi-connect.tsx` (add fields + wire Save & Connect)
- Modify: `messages/en.json` (add field labels under `Settings.whatsapp`)

**Interfaces:**
- Consumes: `Input`, `Label` from `@/components/ui/*`; existing `UazapiConnectProps`.
- New props: `initialBaseUrl?: string | null`, `hasSavedToken?: boolean` (passed by `whatsapp-config.tsx`, Task 6).

- [ ] **Step 1: Add i18n keys**

Run this to add the keys (guarantees valid JSON):

```bash
node -e "
const fs=require('fs');
const p='./messages/en.json';
const m=JSON.parse(fs.readFileSync(p,'utf8'));
Object.assign(m.Settings.whatsapp, {
  uazapiServerUrlLabel:'UAZAPI server URL',
  uazapiServerUrlPlaceholder:'https://your-subdomain.uazapi.com',
  uazapiAdminTokenLabel:'Admin token',
  uazapiAdminTokenHint:'Server-level token used to create this account\'s instance. Stored encrypted.',
  uazapiSaveAndConnect:'Save & Connect',
  uazapiServerRequired:'Enter the server URL and admin token first.',
  uazapiEditServer:'Change server',
});
fs.writeFileSync(p, JSON.stringify(m,null,2)+'\n');
console.log('added keys');
"
```

Expected: prints `added keys`.

- [ ] **Step 2: Rewrite `uazapi-connect.tsx`**

Replace the entire contents of `src/components/settings/uazapi-connect.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type UazapiStatus = 'disconnected' | 'connecting' | 'connected';

const MASKED_TOKEN = '••••••••••••••••';

interface UazapiConnectProps {
  initialStatus?: UazapiStatus;
  initialWaNumber?: string | null;
  initialBaseUrl?: string | null;
  hasSavedToken?: boolean;
  onChange?: () => void;
}

const STATUS_POLL_MS = 3000;
const QR_REFRESH_MS = 45000;

function toQrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

/**
 * UAZAPI QR pairing panel with per-account server config. Owns the
 * server-fields → save+connect → poll → connected/disconnect lifecycle,
 * talking only to /api/whatsapp/uazapi/*.
 */
export function UazapiConnect({
  initialStatus,
  initialWaNumber,
  initialBaseUrl,
  hasSavedToken,
  onChange,
}: UazapiConnectProps) {
  const t = useTranslations('Settings.whatsapp');

  const [status, setStatus] = useState<UazapiStatus>(initialStatus ?? 'disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState<string | null>(initialWaNumber ?? null);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? '');
  // Masked when a token is already saved; the user only re-enters it to change it.
  const [adminToken, setAdminToken] = useState(hasSavedToken ? MASKED_TOKEN : '');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopLoops = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    pollRef.current = null;
    qrTimerRef.current = null;
  }, []);

  useEffect(() => stopLoops, [stopLoops]);

  const startConnect = useCallback(async (): Promise<boolean> => {
    // Send credentials only when the user provided/changed them. A masked
    // token means "use the stored one" — never round-trip the secret.
    const payload: { baseUrl?: string; adminToken?: string } = {};
    if (baseUrl.trim()) payload.baseUrl = baseUrl.trim();
    if (adminToken && adminToken !== MASKED_TOKEN) payload.adminToken = adminToken;

    const res = await fetch('/api/whatsapp/uazapi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.error || t('uazapiConnectFailed'));
      return false;
    }
    setQrCode(data.qrCode ?? null);
    setStatus('connecting');
    return true;
  }, [baseUrl, adminToken, t]);

  const pollStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/uazapi/status');
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.status === 'connected') {
      stopLoops();
      setStatus('connected');
      setWaNumber(data.waNumber ?? null);
      setQrCode(null);
      onChange?.();
    }
  }, [stopLoops, onChange]);

  const handleConnect = useCallback(async () => {
    // Require both fields when nothing is saved yet.
    if (!baseUrl.trim() || (!hasSavedToken && (!adminToken || adminToken === MASKED_TOKEN))) {
      toast.error(t('uazapiServerRequired'));
      return;
    }
    setConnecting(true);
    try {
      const ok = await startConnect();
      if (!ok) return;
      stopLoops();
      pollRef.current = setInterval(pollStatus, STATUS_POLL_MS);
      qrTimerRef.current = setInterval(() => {
        void startConnect();
      }, QR_REFRESH_MS);
    } finally {
      setConnecting(false);
    }
  }, [baseUrl, adminToken, hasSavedToken, startConnect, pollStatus, stopLoops, t]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to disconnect.');
        return;
      }
      stopLoops();
      setStatus('disconnected');
      setQrCode(null);
      setWaNumber(null);
      onChange?.();
    } finally {
      setDisconnecting(false);
    }
  }, [stopLoops, onChange]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-foreground">{t('uazapiTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('uazapiDesc')}
            </CardDescription>
          </div>
          {status === 'connected' ? (
            <Badge className="bg-primary/15 text-primary border-primary/30">
              <CheckCircle2 className="size-3.5" />
              {t('uazapiConnected')}
            </Badge>
          ) : status === 'connecting' ? (
            <Badge variant="secondary">
              <Loader2 className="size-3.5 animate-spin" />
              {t('uazapiWaitingScan')}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {status === 'connected' ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
            <Smartphone className="size-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">{t('uazapiConnectedNumber')}</p>
              <p className="text-foreground font-medium">{waNumber || '—'}</p>
              {baseUrl ? <p className="text-xs text-muted-foreground mt-1">{baseUrl}</p> : null}
            </div>
            <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('uazapiDisconnecting')}
                </>
              ) : (
                t('uazapiDisconnect')
              )}
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="uazapi-base-url">{t('uazapiServerUrlLabel')}</Label>
                <Input
                  id="uazapi-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t('uazapiServerUrlPlaceholder')}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="uazapi-admin-token">{t('uazapiAdminTokenLabel')}</Label>
                <Input
                  id="uazapi-admin-token"
                  type="password"
                  value={adminToken}
                  onFocus={() => {
                    if (adminToken === MASKED_TOKEN) setAdminToken('');
                  }}
                  onChange={(e) => setAdminToken(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">{t('uazapiAdminTokenHint')}</p>
              </div>
            </div>

            {qrCode ? (
              <div className="flex flex-col items-center gap-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={toQrSrc(qrCode)}
                  alt="WhatsApp QR code"
                  className="size-56 rounded-lg border border-border bg-white p-2"
                />
                <p className="text-sm text-muted-foreground text-center max-w-sm">
                  {t('uazapiScanHint')}
                </p>
                <Button variant="ghost" size="sm" onClick={handleConnect} disabled={connecting}>
                  <RefreshCw className="size-4" />
                  {t('uazapiRefreshQr')}
                </Button>
              </div>
            ) : (
              <div className="flex justify-center py-2">
                <Button onClick={handleConnect} disabled={connecting}>
                  {connecting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('uazapiConnecting')}
                    </>
                  ) : (
                    <>
                      <QrCode className="size-4" />
                      {t('uazapiSaveAndConnect')}
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors. (Task 6 wires the new props; a transient "unused prop" is fine — do not treat as failure.)

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/uazapi-connect.tsx messages/en.json
git commit -m "feat(whatsapp): add per-account UAZAPI server fields to Settings"
```

---

### Task 6: Wire the new props + drop env config

**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx` (pass `initialBaseUrl` + `hasSavedToken` to `UazapiConnect`)
- Modify: `.env.production.example` (remove the UAZAPI env block)

**Interfaces:**
- Consumes: `config?.uazapi_base_url`, `config?.uazapi_admin_token` (WhatsAppConfig, Task 1).

- [ ] **Step 1: Pass the new props**

In `src/components/settings/whatsapp-config.tsx`, find the `<UazapiConnect .../>` usage inside the `if (provider === 'uazapi')` early return and replace it with:

```tsx
        <UazapiConnect
          initialStatus={config?.uazapi_status}
          initialWaNumber={config?.uazapi_wa_number}
          initialBaseUrl={config?.uazapi_base_url}
          hasSavedToken={!!config?.uazapi_admin_token}
          onChange={() => {
            if (accountId) fetchConfig(accountId);
          }}
        />
```

- [ ] **Step 2: Remove the UAZAPI env block from the example**

In `.env.production.example`, delete these lines (the comment block + both vars):

```
# UAZAPI (unofficial, QR-paired WhatsApp provider). Only needed if any
# account connects via QR code instead of the Meta Cloud API. The server
# URL is the UAZAPI host; the admin token mints per-account instances.
# Leave unset to disable the QR option (the connect route returns a clear
# "not configured" message).
UAZAPI_SERVER_URL=https://your-subdomain.uazapi.com
UAZAPI_ADMIN_TOKEN=your-uazapi-admin-token
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `npx vitest run src/lib/whatsapp/`
Expected: all pass (the 2 pre-existing `dashboard/date-utils` failures are out of scope and not run here).

- [ ] **Step 4: Production build**

Run: `npx next build`
Expected: build succeeds; the four `/api/whatsapp/uazapi/*` routes appear in the route manifest.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx .env.production.example
git commit -m "feat(whatsapp): wire per-account UAZAPI server fields; drop env config"
```

---

## Deployment (after merge)

1. Apply migration `037_uazapi_admin_token.sql` to Supabase (Dashboard → SQL Editor), same as 036.
2. `UAZAPI_SERVER_URL` / `UAZAPI_ADMIN_TOKEN` in `/opt/waizor-v2/.env` are now dead — remove them.
3. Deploy: on the VPS `git pull` on `main` (after merge) + `./deploy.sh` (now force-rolls the image).
