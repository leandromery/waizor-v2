/**
 * UAZAPI (uazapiGO) HTTP helpers — the raw transport layer for the
 * unofficial, session-based WhatsApp provider. This is UAZAPI's analogue
 * of meta-api.ts: every function takes a single named-parameter options
 * object and returns parsed data, so the provider adapter and the
 * connect/webhook routes never build requests by hand.
 *
 * Auth model (verified against uazapiGO spec v2.1.1):
 *   - `admintoken` header — server-level, guards /instance/create only.
 *   - `token` header — the per-instance token, guards every other op.
 * Server base URL is per-instance (`https://{subdomain}.uazapi.com`) and
 * lives in whatsapp_config.uazapi_base_url.
 */

/** UAZAPI instance object (subset we use — see Instance schema). */
export interface UazapiInstance {
  id: string
  token?: string
  status: 'disconnected' | 'connecting' | 'connected' | 'hibernated'
  qrcode?: string
  paircode?: string
  profileName?: string
  profilePicUrl?: string
  owner?: string
}

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorResponse {
  error?: string
  message?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.error) message = data.error
    else if (data.message) message = data.message
  } catch {
    // body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

/**
 * POST/GET a UAZAPI endpoint with the given auth header. `authHeader` is
 * `token` for per-instance ops and `admintoken` for /instance/create.
 */
async function uazapiFetch<T>(args: {
  baseUrl: string
  path: string
  method?: 'GET' | 'POST'
  authHeader: 'token' | 'admintoken'
  authValue: string
  body?: Record<string, unknown>
}): Promise<T> {
  const { baseUrl, path, method = 'POST', authHeader, authValue, body } = args
  const headers: Record<string, string> = { [authHeader]: authValue }
  if (body) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`)
  }
  return response.json() as Promise<T>
}

// ============================================================
// Outbound sends (per-instance token)
// ============================================================

export interface UazapiSendTextArgs {
  baseUrl: string
  token: string
  number: string
  text: string
  /** Provider message id to quote (swipe-reply). */
  replyid?: string
}

export async function sendText(args: UazapiSendTextArgs): Promise<UazapiSendResult> {
  const { baseUrl, token, number, text, replyid } = args
  const body: Record<string, unknown> = { number, text }
  if (replyid) body.replyid = replyid
  const data = await uazapiFetch<{ messageid: string }>({
    baseUrl,
    path: '/send/text',
    authHeader: 'token',
    authValue: token,
    body,
  })
  return { messageId: data.messageid }
}

/** UAZAPI /send/media `type` set (we only emit this subset). */
export type UazapiMediaType = 'image' | 'video' | 'document' | 'audio' | 'ptt'

export interface UazapiSendMediaArgs {
  baseUrl: string
  token: string
  number: string
  type: UazapiMediaType
  /** URL or base64 of the file. */
  file: string
  /** Caption. */
  text?: string
  /** Document filename (documents only). */
  docName?: string
  replyid?: string
}

export async function sendMedia(args: UazapiSendMediaArgs): Promise<UazapiSendResult> {
  const { baseUrl, token, number, type, file, text, docName, replyid } = args
  const body: Record<string, unknown> = { number, type, file }
  if (text) body.text = text
  if (docName) body.docName = docName
  if (replyid) body.replyid = replyid
  const data = await uazapiFetch<{ messageid: string }>({
    baseUrl,
    path: '/send/media',
    authHeader: 'token',
    authValue: token,
    body,
  })
  return { messageId: data.messageid }
}

export interface UazapiSendMenuArgs {
  baseUrl: string
  token: string
  number: string
  type: 'button' | 'list'
  text: string
  footerText?: string
  /** List-only: label of the button that opens the list. */
  listButton?: string
  /**
   * Encoded options. Button item = `"title|id"`; list item =
   * `"title|id|description"`, and `"[Section]"` starts a list section.
   */
  choices: string[]
  replyid?: string
}

export async function sendMenu(args: UazapiSendMenuArgs): Promise<UazapiSendResult> {
  const { baseUrl, token, number, type, text, footerText, listButton, choices, replyid } = args
  const body: Record<string, unknown> = { number, type, text, choices }
  if (footerText) body.footerText = footerText
  if (listButton) body.listButton = listButton
  if (replyid) body.replyid = replyid
  const data = await uazapiFetch<{ messageid: string }>({
    baseUrl,
    path: '/send/menu',
    authHeader: 'token',
    authValue: token,
    body,
  })
  return { messageId: data.messageid }
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateInstanceArgs {
  baseUrl: string
  /** Server-level admin token (guards create only). */
  adminToken: string
  name: string
}

export async function createInstance(args: CreateInstanceArgs): Promise<UazapiInstance> {
  const { baseUrl, adminToken, name } = args
  const data = await uazapiFetch<{ instance: UazapiInstance; token?: string }>({
    baseUrl,
    path: '/instance/create',
    authHeader: 'admintoken',
    authValue: adminToken,
    body: { name },
  })
  // The token is returned both inside `instance` and at the top level;
  // prefer the instance copy, fall back to the top-level one.
  return { ...data.instance, token: data.instance?.token ?? data.token }
}

export interface UazapiInstanceContext {
  baseUrl: string
  token: string
}

export interface ConnectInstanceArgs extends UazapiInstanceContext {
  /** If given, UAZAPI returns a pairing code instead of a QR code. */
  phone?: string
}

export async function connectInstance(args: ConnectInstanceArgs): Promise<UazapiInstance> {
  const { baseUrl, token, phone } = args
  const data = await uazapiFetch<{ instance: UazapiInstance }>({
    baseUrl,
    path: '/instance/connect',
    authHeader: 'token',
    authValue: token,
    body: phone ? { phone } : {},
  })
  return data.instance
}

export interface UazapiStatusResult {
  instance: UazapiInstance
  connected: boolean
  loggedIn: boolean
  /** The paired WhatsApp number (from `status.jid.user`), once connected. */
  waNumber?: string
}

export async function getInstanceStatus(
  args: UazapiInstanceContext
): Promise<UazapiStatusResult> {
  const { baseUrl, token } = args
  const data = await uazapiFetch<{
    instance: UazapiInstance
    status?: { connected?: boolean; loggedIn?: boolean; jid?: { user?: string } | null }
  }>({
    baseUrl,
    path: '/instance/status',
    method: 'GET',
    authHeader: 'token',
    authValue: token,
  })
  return {
    instance: data.instance,
    connected: data.status?.connected ?? false,
    loggedIn: data.status?.loggedIn ?? false,
    waNumber: data.status?.jid?.user,
  }
}

export async function disconnectInstance(args: UazapiInstanceContext): Promise<void> {
  const { baseUrl, token } = args
  await uazapiFetch<unknown>({
    baseUrl,
    path: '/instance/disconnect',
    authHeader: 'token',
    authValue: token,
    body: {},
  })
}

// ============================================================
// Webhook configuration (point UAZAPI at our inbound route)
// ============================================================

export interface ConfigureWebhookArgs extends UazapiInstanceContext {
  url: string
  /** Plural event names — e.g. ['messages', 'connection']. */
  events: string[]
  /** e.g. ['wasSentByApi'] to suppress our own echoed sends. */
  excludeMessages?: string[]
}

export async function configureWebhook(args: ConfigureWebhookArgs): Promise<void> {
  const { baseUrl, token, url, events, excludeMessages } = args
  const body: Record<string, unknown> = { url, events }
  if (excludeMessages) body.excludeMessages = excludeMessages
  await uazapiFetch<unknown>({
    baseUrl,
    path: '/webhook',
    authHeader: 'token',
    authValue: token,
    body,
  })
}
