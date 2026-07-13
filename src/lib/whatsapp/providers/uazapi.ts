/**
 * UAZAPI provider — adapts our provider-agnostic outbound interface to
 * UAZAPI's HTTP API (uazapi-api.ts). The UAZAPI analogue of meta.ts.
 *
 * Differences from Meta that live here:
 *   - Credentials are `uazapi_base_url` + the encrypted
 *     `uazapi_instance_token` (not phone_number_id + access_token).
 *   - There is no template concept, so `capabilities.templates` is false
 *     and `sendTemplate` is not implemented.
 *   - Interactive messages go through one `/send/menu` endpoint whose
 *     `choices` encode our stable button/row ids inline (`title|id`,
 *     `title|id|description`, `[Section]`).
 */
import { sendText, sendMedia, sendMenu, type UazapiMediaType } from '@/lib/whatsapp/uazapi-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type {
  WhatsAppProvider,
  OutboundContext,
  SendTextInput,
  SendMediaInput,
  SendInteractiveInput,
  SendResult,
} from './types'

/** Resolve base URL + decrypted instance token off the config. */
function uazapiCredentials(ctx: OutboundContext): { baseUrl: string; token: string } {
  const { config } = ctx
  if (!config.uazapi_base_url || !config.uazapi_instance_token) {
    throw new Error(
      'UAZAPI WhatsApp config is missing its base url or instance token.'
    )
  }
  return {
    baseUrl: config.uazapi_base_url,
    token: decrypt(config.uazapi_instance_token),
  }
}

// Our MediaKind (image|video|document|audio) is a subset of UAZAPI's
// media types, so the mapping is identity today. Kept explicit so a
// future MediaKind addition forces a decision here.
const MEDIA_TYPE: Record<MediaKind, UazapiMediaType> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
}

/** Join our header + body into UAZAPI's single `text` field. */
function menuText(header: string | undefined, body: string): string {
  return header ? `${header}\n\n${body}` : body
}

/** Encode an interactive payload into UAZAPI `/send/menu` choices. */
function encodeChoices(payload: InteractiveMessagePayload): string[] {
  if (payload.kind === 'buttons') {
    return payload.buttons.map((b) => `${b.title}|${b.id}`)
  }
  const choices: string[] = []
  for (const section of payload.sections) {
    if (section.title) choices.push(`[${section.title}]`)
    for (const row of section.rows) {
      choices.push(
        row.description
          ? `${row.title}|${row.id}|${row.description}`
          : `${row.title}|${row.id}`
      )
    }
  }
  return choices
}

export const uazapiProvider: WhatsAppProvider = {
  id: 'uazapi',
  capabilities: { templates: false, interactive: true, broadcast: false },

  async sendText(ctx, input: SendTextInput): Promise<SendResult> {
    const { baseUrl, token } = uazapiCredentials(ctx)
    return sendText({
      baseUrl,
      token,
      number: input.to,
      text: input.text,
      replyid: input.contextMessageId,
    })
  },

  async sendMedia(ctx, input: SendMediaInput): Promise<SendResult> {
    const { baseUrl, token } = uazapiCredentials(ctx)
    return sendMedia({
      baseUrl,
      token,
      number: input.to,
      type: MEDIA_TYPE[input.kind],
      file: input.link,
      text: input.caption,
      docName: input.filename,
      replyid: input.contextMessageId,
    })
  },

  async sendInteractive(ctx, input: SendInteractiveInput): Promise<SendResult> {
    const { baseUrl, token } = uazapiCredentials(ctx)
    const p = input.payload
    return sendMenu({
      baseUrl,
      token,
      number: input.to,
      type: p.kind === 'buttons' ? 'button' : 'list',
      text: menuText(p.header, p.body),
      footerText: p.footer,
      listButton: p.kind === 'list' ? p.button_label : undefined,
      choices: encodeChoices(p),
      replyid: input.contextMessageId,
    })
  },
}
