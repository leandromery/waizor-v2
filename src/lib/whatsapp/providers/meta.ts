/**
 * Meta Cloud API provider — a thin adapter over the existing meta-api.ts
 * helpers. Behavior here is intentionally byte-for-byte identical to the
 * inline dispatch that used to live in send-message.ts, so migrating to
 * the provider seam cannot regress the Meta path.
 */
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import type {
  WhatsAppProvider,
  OutboundContext,
  SendTextInput,
  SendMediaInput,
  SendInteractiveInput,
  SendTemplateInput,
  SendResult,
} from './types'

/**
 * Resolve the Meta credentials off the config, decrypting the access
 * token. Self-heals legacy CBC ciphertexts to GCM (fire-and-forget,
 * idempotent) — the same upgrade send-message.ts used to do inline.
 */
function metaCredentials(ctx: OutboundContext): {
  phoneNumberId: string
  accessToken: string
} {
  const { config, db } = ctx
  if (!config.phone_number_id || !config.access_token) {
    throw new Error(
      'Meta WhatsApp config is missing phone_number_id or access_token.'
    )
  }
  const accessToken = decrypt(config.access_token)

  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[meta-provider] access_token GCM upgrade failed:',
            error.message
          )
        }
      })
  }

  return { phoneNumberId: config.phone_number_id, accessToken }
}

export const metaProvider: WhatsAppProvider = {
  id: 'meta',
  capabilities: { templates: true, interactive: true, broadcast: true },

  async sendText(ctx, input: SendTextInput): Promise<SendResult> {
    const { phoneNumberId, accessToken } = metaCredentials(ctx)
    const result = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: input.to,
      text: input.text,
      contextMessageId: input.contextMessageId,
    })
    return { messageId: result.messageId }
  },

  async sendMedia(ctx, input: SendMediaInput): Promise<SendResult> {
    const { phoneNumberId, accessToken } = metaCredentials(ctx)
    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: input.to,
      kind: input.kind,
      link: input.link,
      caption: input.caption,
      filename: input.filename,
      contextMessageId: input.contextMessageId,
    })
    return { messageId: result.messageId }
  },

  async sendTemplate(ctx, input: SendTemplateInput): Promise<SendResult> {
    const { phoneNumberId, accessToken } = metaCredentials(ctx)
    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: input.to,
      templateName: input.templateName,
      language: input.language || 'en_US',
      template: input.template,
      messageParams: input.messageParams,
      params: input.params || [],
      contextMessageId: input.contextMessageId,
    })
    return { messageId: result.messageId }
  },

  async sendInteractive(
    ctx,
    input: SendInteractiveInput
  ): Promise<SendResult> {
    const { phoneNumberId, accessToken } = metaCredentials(ctx)
    const p = input.payload
    if (p.kind === 'buttons') {
      const result = await sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: input.to,
        bodyText: p.body,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        buttons: p.buttons,
        contextMessageId: input.contextMessageId,
      })
      return { messageId: result.messageId }
    }
    const result = await sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: input.to,
      bodyText: p.body,
      buttonLabel: p.button_label,
      headerText: p.header || undefined,
      footerText: p.footer || undefined,
      sections: p.sections,
      contextMessageId: input.contextMessageId,
    })
    return { messageId: result.messageId }
  },
}
