/**
 * UAZAPI inbound normalizer.
 *
 * Turns one UAZAPI webhook `message` object (the real envelope is
 * `{ EventType, instanceName, message, ... }`, NOT the spec's
 * `{ event, instance, data }`) into the shared NormalizedInbound shape
 * consumed by process.ts.
 *
 * Two UAZAPI quirks the field mapping handles:
 *   1. `sender` is a LID (`…@lid`), not a phone. The real phone number is
 *      in `sender_pn` / `chatid` (`…@s.whatsapp.net`).
 *   2. Optional fields come as empty strings (`""`), not absent — so we
 *      coerce "" to null for quoted/reaction/buttonOrListid/text.
 *   3. Media has no download step — `fileURL` is a public URL.
 *
 * We also drop our own echoed sends (`fromMe`) and group messages
 * (`isGroup`) — the CRM is strictly 1:1.
 */
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInbound, NormalizedContentType } from './types'

/** Subset of UAZAPI's webhook `message` object we read on inbound. */
export interface UazapiMessage {
  messageid: string
  /** LID JID of the sender (`…@lid`) — NOT a phone number. */
  sender: string
  /** Phone-number JID (`…@s.whatsapp.net`) — the real phone. */
  sender_pn?: string
  /** Chat JID, also the contact's phone JID for 1:1. */
  chatid?: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  /** Simple content type, e.g. "text", "image", "ptt". */
  type?: string
  /** Baileys-style type, e.g. "Conversation", "imageMessage". */
  messageType?: string
  /** Media kind hint, e.g. "image", "ptt" (empty for text). */
  mediaType?: string
  /** Unix milliseconds. */
  messageTimestamp: number
  text?: string
  /** Provider id of the quoted message ("" when none). */
  quoted?: string
  /** Provider id of the reacted-to message ("" when none). */
  reaction?: string
  /** Selected button/list option id ("" when none). */
  buttonOrListid?: string
  /**
   * Raw content. A string for text, but an OBJECT (encrypted CDN URL +
   * mediaKey) for media — so we never read it directly; media is resolved
   * out-of-band via the download callback.
   */
  content?: unknown
}

/** Content types that carry downloadable media. */
const MEDIA_TYPES = new Set<NormalizedContentType>([
  'image',
  'video',
  'audio',
  'document',
])

/** Coerce UAZAPI's empty-string "absent" markers to null. */
function nz(v: string | undefined): string | null {
  return v && v.length > 0 ? v : null
}

/**
 * Classify a UAZAPI message into our content type, matching on the `type`
 * / `messageType` / `mediaType` keywords and the presence of an interactive
 * reply id.
 */
function classify(message: UazapiMessage): NormalizedContentType {
  if (nz(message.reaction)) return 'text' // reactions short-circuit downstream
  if (nz(message.buttonOrListid)) return 'interactive'

  const t = `${message.type ?? ''} ${message.messageType ?? ''} ${message.mediaType ?? ''}`.toLowerCase()
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
function stripJid(jid: string): string {
  const at = jid.indexOf('@')
  return at === -1 ? jid : jid.slice(0, at)
}

/**
 * Normalize one UAZAPI inbound message. Returns null when the message must
 * be ignored (our own send, or a group message).
 *
 * `resolveMedia` fetches a usable media URL for a message id (UAZAPI's
 * webhook only carries an encrypted CDN URL, so media is resolved via
 * `/message/download`). It's optional — omitted, media messages arrive with
 * a null `mediaUrl`.
 */
export async function normalizeUazapiMessage(
  message: UazapiMessage,
  resolveMedia?: (messageId: string) => Promise<string | null>
): Promise<NormalizedInbound | null> {
  if (message.fromMe || message.isGroup) return null

  const contentType = classify(message)

  // The real phone is in sender_pn / chatid; `sender` is a LID.
  const phoneJid = message.sender_pn || message.chatid || message.sender
  const reactionId = nz(message.reaction)

  const mediaUrl =
    MEDIA_TYPES.has(contentType) && resolveMedia
      ? await resolveMedia(message.messageid)
      : null

  return {
    providerMessageId: message.messageid,
    fromPhone: normalizePhone(stripJid(phoneJid)),
    contactName: message.senderName ?? '',
    timestampSeconds: Math.floor(message.messageTimestamp / 1000),
    typeLabel: contentType,
    contentType,
    contentText: nz(message.text),
    mediaUrl,
    interactiveReplyId: nz(message.buttonOrListid),
    replyToProviderMessageId: nz(message.quoted),
    reaction: reactionId
      ? { targetProviderMessageId: reactionId, emoji: message.text ?? '' }
      : null,
  }
}
