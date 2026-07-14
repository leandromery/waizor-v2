import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { processInboundMessage } from '@/lib/whatsapp/inbound/process'
import { decrypt } from '@/lib/whatsapp/encryption'
import { downloadMessage } from '@/lib/whatsapp/uazapi-api'
import {
  normalizeUazapiMessage,
  type UazapiMessage,
} from '@/lib/whatsapp/inbound/uazapi-normalize'

/**
 * UAZAPI inbound webhook.
 *
 * The real UAZAPI envelope is `{ EventType, instanceName, message, ... }`
 * (NOT the spec's `{ event, instance, data }`). We act only on `messages`
 * events; everything else (connection, presence, …) is acked and ignored.
 *
 * Auth / tenancy: UAZAPI does not sign its callbacks and the message event
 * carries no instance id — only `instanceName`, which we mint as
 * `waizor-<accountId>`. We resolve the owning account by parsing that
 * accountId out of `instanceName` (an unguessable UUID) and loading its
 * UAZAPI config with the service-role client (no user session on a
 * webhook). Unknown/non-UAZAPI accounts are ignored. Defence-in-depth:
 * `excludeMessages: ['wasSentByApi']` is set at connect time.
 */

const INSTANCE_NAME_PREFIX = 'waizor-'

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
  EventType?: string
  /** `waizor-<accountId>` — the instance name we set on create. */
  instanceName?: string
  message?: UazapiMessage
}

export async function POST(request: Request) {
  let body: UazapiWebhookEvent
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

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

/** Extract the account id we embedded in `waizor-<accountId>`. */
function accountIdFromInstanceName(instanceName: string | undefined): string | null {
  if (!instanceName || !instanceName.startsWith(INSTANCE_NAME_PREFIX)) return null
  const id = instanceName.slice(INSTANCE_NAME_PREFIX.length)
  return id.length > 0 ? id : null
}

async function processUazapiEvent(body: UazapiWebhookEvent): Promise<void> {
  if (body.EventType !== 'messages' || !body.message) return

  // Cheap pre-filter (our own sends / groups) before any DB or media work.
  if (body.message.fromMe || body.message.isGroup) return

  const accountId = accountIdFromInstanceName(body.instanceName)
  if (!accountId) {
    console.warn('[uazapi/webhook] could not resolve account from instanceName:', body.instanceName)
    return
  }

  // Confirm the account exists and is on the UAZAPI provider; also grab the
  // server URL + instance token so we can resolve media.
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, provider, uazapi_base_url, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[uazapi/webhook] config lookup failed:', error)
    return
  }
  if (!config || config.provider !== 'uazapi') {
    console.warn('[uazapi/webhook] no UAZAPI config for account:', accountId)
    return
  }

  // Media resolver: UAZAPI's webhook only carries an encrypted CDN URL, so
  // media messages are resolved to a usable public URL via /message/download.
  // Best-effort — a download failure lands the message without media rather
  // than dropping it.
  let resolveMedia: ((id: string) => Promise<string | null>) | undefined
  if (config.uazapi_base_url && config.uazapi_instance_token) {
    const baseUrl = config.uazapi_base_url as string
    const token = decrypt(config.uazapi_instance_token as string)
    resolveMedia = async (id: string) => {
      try {
        const { fileURL } = await downloadMessage({ baseUrl, token, id })
        return fileURL
      } catch (err) {
        console.warn(
          '[uazapi/webhook] media download failed:',
          err instanceof Error ? err.message : err,
        )
        return null
      }
    }
  }

  const normalized = await normalizeUazapiMessage(body.message, resolveMedia)
  if (!normalized) return

  await processInboundMessage(
    normalized,
    config.account_id as string,
    config.user_id as string,
  )
}
