/**
 * Meta Cloud API inbound normalizer.
 *
 * Turns a Meta webhook message (+ its contact block) into the shared
 * NormalizedInbound shape consumed by process.ts. This is the only
 * inbound code that knows Meta's payload layout and how to resolve Meta
 * media (getMediaUrl → our proxy path).
 */
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInbound, NormalizedContentType } from './types'

export interface MetaWebhookMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  context?: { id: string }
}

export interface MetaWebhookContact {
  profile: { name: string }
  wa_id: string
}

// The messages.content_type CHECK constraint (widened in migration 010)
// allows: text, image, document, audio, video, location, template,
// interactive. Inbound is never a 'template', so we map to the normalized
// subset; stickers render as images and anything else falls back to text.
function toContentType(metaType: string): NormalizedContentType {
  switch (metaType) {
    case 'text':
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'location':
    case 'interactive':
      return metaType
    case 'sticker':
      return 'image'
    default:
      return 'text'
  }
}

async function parseMessageContent(
  message: MetaWebhookMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
}> {
  // getMediaUrl verifies the media id is fetchable with our token; the
  // actual bytes are streamed later through our authenticated proxy.
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  const empty = { contentText: null, mediaUrl: null, interactiveReplyId: null }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return { ...empty, mediaUrl: await verifyAndBuildUrl(message.audio.id) }
      }
      return empty

    case 'sticker':
      if (message.sticker?.id) {
        return { ...empty, mediaUrl: await verifyAndBuildUrl(message.sticker.id) }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or list row on a message we
      // sent. Use the human-readable title as contentText; stash the
      // stable id so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

/**
 * Normalize one Meta inbound message (+ contact) into NormalizedInbound.
 * Downloads/verifies media as a side effect (via getMediaUrl).
 */
export async function normalizeMetaMessage(
  message: MetaWebhookMessage,
  contact: MetaWebhookContact,
  accessToken: string
): Promise<NormalizedInbound> {
  const parsed = await parseMessageContent(message, accessToken)

  const reaction =
    message.type === 'reaction'
      ? {
          targetProviderMessageId: message.reaction?.message_id ?? '',
          emoji: message.reaction?.emoji ?? '',
        }
      : null

  return {
    providerMessageId: message.id,
    fromPhone: normalizePhone(message.from),
    contactName: contact.profile.name,
    timestampSeconds: parseInt(message.timestamp, 10),
    typeLabel: message.type,
    contentType: toContentType(message.type),
    contentText: parsed.contentText,
    mediaUrl: parsed.mediaUrl,
    interactiveReplyId: parsed.interactiveReplyId,
    replyToProviderMessageId: message.context?.id ?? null,
    reaction,
  }
}
