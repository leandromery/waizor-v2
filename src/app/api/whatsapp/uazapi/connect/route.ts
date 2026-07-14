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
