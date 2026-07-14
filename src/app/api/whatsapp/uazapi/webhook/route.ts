import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { processInboundMessage } from '@/lib/whatsapp/inbound/process'
import {
  normalizeUazapiMessage,
  type UazapiMessage,
} from '@/lib/whatsapp/inbound/uazapi-normalize'

/**
 * UAZAPI inbound webhook.
 *
 * UAZAPI POSTs events here as `{ event, instance, data }`. We only act on
 * `message` events; everything else (status, presence, …) is acked and
 * ignored for v1.
 *
 * Auth model: UAZAPI does not sign its callbacks, so we authenticate by
 * resolving the account from the `instance` id (which is an unguessable,
 * per-account UAZAPI identifier) and ignore any unknown instance. See the
 * design spec's "Resolved confirmations" for why this is acceptable for
 * v1 (defence-in-depth `excludeMessages: ['wasSentByApi']` is set at
 * connect time). We resolve with the service-role client because there's
 * no user session on an inbound webhook.
 */

// Lazy service-role client — mirrors the Meta webhook route. RLS can't
// scope an unauthenticated webhook, so we resolve tenancy explicitly.
// Typed `any` like the Meta/config routes: the un-generic'd client infers
// `never` rows otherwise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface UazapiWebhookEvent {
  event?: string
  instance?: string
  data?: UazapiMessage
}

export async function POST(request: Request) {
  let body: UazapiWebhookEvent
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // TEMP DEBUG: log the envelope shape so we can confirm UAZAPI is calling
  // us and what event name / message shape it actually sends.
  console.log(
    '[uazapi/webhook] envelope:',
    JSON.stringify({
      event: body?.event,
      instance: body?.instance,
      topKeys: body ? Object.keys(body) : null,
      dataKeys: body?.data ? Object.keys(body.data) : null,
      messageType: body?.data?.messageType,
      fromMe: body?.data?.fromMe,
      isGroup: body?.data?.isGroup,
    }),
  )

  // Process after the response so we ack UAZAPI promptly (a slow ack
  // triggers retries + duplicate inserts) while the work still runs to
  // completion under the runtime — same rationale as the Meta route.
  after(async () => {
    try {
      await processUazapiEvent(body)
    } catch (error) {
      console.error('[uazapi/webhook] processing error:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processUazapiEvent(body: UazapiWebhookEvent): Promise<void> {
  if (body.event !== 'message' || !body.instance || !body.data) return

  // Drop our own sends / group chats before any DB work.
  const normalized = normalizeUazapiMessage(body.data)
  if (!normalized) return

  // Resolve the owning account by instance id. Unknown instance → ignore.
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, provider')
    .eq('uazapi_instance_id', body.instance)
    .maybeSingle()

  if (error) {
    console.error('[uazapi/webhook] config lookup failed:', error)
    return
  }
  if (!config || config.provider !== 'uazapi') {
    console.warn('[uazapi/webhook] no UAZAPI config for instance:', body.instance)
    return
  }

  await processInboundMessage(
    normalized,
    config.account_id as string,
    config.user_id as string,
  )
}
