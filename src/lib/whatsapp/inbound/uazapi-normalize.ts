/**
 * UAZAPI inbound normalizer.
 *
 * Turns one UAZAPI webhook `Message` (the `data` of a `message` event)
 * into the shared NormalizedInbound shape consumed by process.ts — the
 * UAZAPI analogue of meta-normalize.ts.
 *
 * Two things differ from Meta:
 *   1. Media needs no download step — UAZAPI's `fileURL` is already a
 *      publicly retrievable URL (see the design spec's resolved
 *      confirmations), so we store it verbatim.
 *   2. UAZAPI can deliver our own echoed sends (`fromMe`) and group
 *      messages (`isGroup`), which Meta's webhook never did. The CRM is
 *      strictly 1:1, so we drop both here (defence-in-depth on top of the
 *      `excludeMessages` filter we set when configuring the webhook).
 */
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInbound, NormalizedContentType } from './types'

/** Subset of UAZAPI's Message schema we read on inbound. */
export interface UazapiMessage {
  messageid: string
  /** Sender JID, e.g. `5511999999999@s.whatsapp.net` or `…@lid`. */
  sender: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  messageType: string
  /** Unix milliseconds. */
  messageTimestamp: number
  text?: string
  /** Provider id of the quoted/replied-to message. */
  quoted?: string
  /** For reactions: the provider id of the reacted-to message. */
  reaction?: string
  /** Selected button/list option id. */
  buttonOrListid?: string
  /** Already-public media URL (no download needed). */
  fileURL?: string
}

/**
 * Classify a UAZAPI message into our content type. `messageType` is a
 * mixed bag — sometimes simple (`text`, `reaction`), sometimes raw
 * Baileys (`imageMessage`, `buttonsResponseMessage`, …) — so we match on
 * keywords rather than an exact enum, and let the present fields
 * (buttonOrListid, reaction) act as stronger signals.
 */
function classify(message: UazapiMessage): NormalizedContentType {
  if (message.reaction) return 'text' // reactions short-circuit; type is moot
  if (message.buttonOrListid) return 'interactive'

  const t = message.messageType.toLowerCase()
  if (t.includes('image') || t.includes('sticker')) return 'image'
  if (t.includes('video')) return 'video'
  if (t.includes('audio') || t.includes('ptt')) return 'audio'
  if (t.includes('document')) return 'document'
  if (t.includes('location')) return 'location'
  if (t.includes('button') || t.includes('list') || t.includes('interactive')) {
    return 'interactive'
  }
  return 'text'
}

/** Strip the `@s.whatsapp.net` / `@lid` / `@…` JID suffix. */
function stripJid(sender: string): string {
  const at = sender.indexOf('@')
  return at === -1 ? sender : sender.slice(0, at)
}

/**
 * Normalize one UAZAPI inbound message. Returns null when the message
 * must be ignored (our own send, or a group message).
 */
export function normalizeUazapiMessage(
  message: UazapiMessage
): NormalizedInbound | null {
  if (message.fromMe || message.isGroup) return null

  const contentType = classify(message)

  const reaction = message.reaction
    ? { targetProviderMessageId: message.reaction, emoji: message.text ?? '' }
    : null

  return {
    providerMessageId: message.messageid,
    fromPhone: normalizePhone(stripJid(message.sender)),
    contactName: message.senderName ?? '',
    timestampSeconds: Math.floor(message.messageTimestamp / 1000),
    typeLabel: contentType,
    contentType,
    contentText: message.text ? message.text : null,
    mediaUrl: message.fileURL ?? null,
    interactiveReplyId: message.buttonOrListid ?? null,
    replyToProviderMessageId: message.quoted ?? null,
    reaction,
  }
}
