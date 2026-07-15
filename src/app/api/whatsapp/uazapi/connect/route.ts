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

  // Validate a body-supplied URL up front (also lets us detect a change).
  let normalizedBodyUrl: string | null = null
  if (bodyBaseUrl) {
    try {
      normalizedBodyUrl = normalizeUazapiBaseUrl(bodyBaseUrl)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid UAZAPI server URL.' },
        { status: 400 },
      )
    }
  }

  const storedUrl = existing?.uazapi_base_url ?? null
  const storedToken = existing?.uazapi_admin_token ?? null
  // The URL field is prefilled, so it's sent on every reconnect; a change
  // is only real when it differs from what's stored.
  const urlChanged = !!normalizedBodyUrl && normalizedBodyUrl !== storedUrl

  // Resolve server credentials:
  //  - a token in the body (re)configures the server (new setup / change);
  //  - a changed URL without a token can't authenticate → ask for it (F2);
  //  - otherwise reuse the stored, encrypted pair (reconnect / QR refresh).
  let baseUrl: string
  let adminToken: string
  if (bodyAdminToken) {
    baseUrl = normalizedBodyUrl ?? storedUrl ?? ''
    if (!baseUrl) {
      return NextResponse.json(
        { error: "Configure this account's UAZAPI server URL." },
        { status: 400 },
      )
    }
    adminToken = bodyAdminToken
  } else if (urlChanged) {
    return NextResponse.json(
      { error: 'Changing the UAZAPI server also requires its admin token.' },
      { status: 400 },
    )
  } else if (storedUrl && storedToken) {
    baseUrl = storedUrl
    adminToken = decrypt(storedToken)
  } else {
    return NextResponse.json(
      { error: "Configure this account's UAZAPI server (base URL + admin token) first." },
      { status: 400 },
    )
  }

  // Mint a new instance on first setup or when the server changed; otherwise
  // reuse the stored instance and just refresh its QR.
  const serverChanged = urlChanged
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
    let inst
    try {
      inst = await createInstance({
        baseUrl,
        adminToken,
        name: `waizor-${accountId}`,
      })
    } catch (err) {
      // Surface the UAZAPI error (e.g. "Invalid AdminToken Header") to the
      // user instead of an opaque 500 — this is almost always a wrong admin
      // token or server URL, which only the account admin can fix.
      const message = err instanceof Error ? err.message : 'UAZAPI instance creation failed.'
      console.error('[uazapi/connect] createInstance failed:', message)
      return NextResponse.json(
        { error: `UAZAPI rejected the request: ${message}` },
        { status: 400 },
      )
    }
    if (!inst.token) {
      return NextResponse.json(
        { error: 'UAZAPI did not return an instance token.' },
        { status: 400 },
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

  let connected
  try {
    connected = await connectInstance({ baseUrl, token: instanceToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UAZAPI connect failed.'
    console.error('[uazapi/connect] connectInstance failed:', message)
    return NextResponse.json(
      { error: `UAZAPI rejected the request: ${message}` },
      { status: 400 },
    )
  }
  return NextResponse.json({
    qrCode: connected.qrcode ?? null,
    paircode: connected.paircode ?? null,
    status: connected.status,
  })
}
