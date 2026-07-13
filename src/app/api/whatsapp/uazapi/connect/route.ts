import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { resolveUazapiServer, uazapiWebhookUrl } from '@/lib/whatsapp/uazapi-server'
import {
  createInstance,
  connectInstance,
  configureWebhook,
} from '@/lib/whatsapp/uazapi-api'

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Starts (or refreshes) a UAZAPI QR pairing for the caller's account.
 *
 *  - First time: mints a fresh UAZAPI instance (admin token), stores its
 *    id + encrypted per-instance token on whatsapp_config, and flips the
 *    account's provider to 'uazapi'.
 *  - Subsequent calls: reuse the stored instance and just fetch a new QR
 *    (QR codes are short-lived; the UI polls /status and re-calls this on
 *    expiry).
 *
 * Then points UAZAPI's webhook at our inbound route and returns the QR
 * code (base64) / pairing code for the UI to render.
 *
 * Response: { qrCode: string | null, paircode: string | null, status }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    let server
    try {
      server = resolveUazapiServer()
    } catch (err) {
      // Operator hasn't configured UAZAPI on this deployment — a 400 with
      // the actionable message, not a 500.
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'UAZAPI is not configured.' },
        { status: 400 },
      )
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin
    const webhookUrl = uazapiWebhookUrl(siteUrl)

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, uazapi_base_url, uazapi_instance_id, uazapi_instance_token')
      .eq('account_id', accountId)
      .maybeSingle()

    // Reuse a previously-minted instance when we have one; otherwise mint
    // a fresh one with the server admin token.
    let baseUrl: string
    let instanceId: string
    let instanceToken: string
    if (
      existing?.uazapi_instance_id &&
      existing?.uazapi_instance_token &&
      existing?.uazapi_base_url
    ) {
      baseUrl = existing.uazapi_base_url
      instanceId = existing.uazapi_instance_id
      instanceToken = decrypt(existing.uazapi_instance_token)
    } else {
      const inst = await createInstance({
        baseUrl: server.baseUrl,
        adminToken: server.adminToken,
        name: `waizor-${accountId}`,
      })
      if (!inst.token) {
        return NextResponse.json(
          { error: 'UAZAPI did not return an instance token.' },
          { status: 502 },
        )
      }
      baseUrl = server.baseUrl
      instanceId = inst.id
      instanceToken = inst.token
    }

    // Persist provider switch + instance credentials (token encrypted).
    const row = {
      provider: 'uazapi',
      uazapi_base_url: baseUrl,
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

    // Point UAZAPI at our inbound webhook. Best-effort: a failure here
    // shouldn't stop the user from scanning the QR — status polling still
    // works, and the next connect retries this.
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

    // Kick off the pairing and return the QR / pairing code.
    const connected = await connectInstance({ baseUrl, token: instanceToken })
    return NextResponse.json({
      qrCode: connected.qrcode ?? null,
      paircode: connected.paircode ?? null,
      status: connected.status,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
