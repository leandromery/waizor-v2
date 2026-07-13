import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeMetaMessage, type MetaWebhookMessage } from './meta-normalize'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// getMediaUrl hits Meta to verify a media id is fetchable; we control it
// so media-bearing types resolve to our proxy path (or null on failure).
const getMediaUrl = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (args: unknown) => getMediaUrl(args),
}))

const CONTACT = { profile: { name: 'Ana' }, wa_id: '5511999999999' }
const TOKEN = 'access-token'

function msg(over: Partial<MetaWebhookMessage>): MetaWebhookMessage {
  return {
    id: 'wamid.ABC',
    from: '5511999999999',
    timestamp: '1700000000',
    type: 'text',
    ...over,
  }
}

beforeEach(() => {
  getMediaUrl.mockReset()
  getMediaUrl.mockResolvedValue(undefined) // default: media verifies OK
})

describe('normalizeMetaMessage', () => {
  it('carries the common envelope fields', async () => {
    const n = await normalizeMetaMessage(
      msg({ text: { body: 'oi' } }),
      CONTACT,
      TOKEN
    )
    expect(n.providerMessageId).toBe('wamid.ABC')
    expect(n.fromPhone).toBe(normalizePhone('5511999999999'))
    expect(n.contactName).toBe('Ana')
    expect(n.timestampSeconds).toBe(1700000000)
    expect(n.typeLabel).toBe('text')
    expect(n.reaction).toBeNull()
    expect(n.replyToProviderMessageId).toBeNull()
  })

  it('normalizes a text message', async () => {
    const n = await normalizeMetaMessage(msg({ text: { body: 'hello' } }), CONTACT, TOKEN)
    expect(n.contentType).toBe('text')
    expect(n.contentText).toBe('hello')
    expect(n.mediaUrl).toBeNull()
    expect(getMediaUrl).not.toHaveBeenCalled()
  })

  it('normalizes an image with caption to the media proxy path', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'image', image: { id: 'MID', mime_type: 'image/jpeg', caption: 'pic' } }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('image')
    expect(n.contentText).toBe('pic')
    expect(n.mediaUrl).toBe('/api/whatsapp/media/MID')
    expect(getMediaUrl).toHaveBeenCalledWith({ mediaId: 'MID', accessToken: TOKEN })
  })

  it('yields a null mediaUrl when media verification fails', async () => {
    getMediaUrl.mockRejectedValue(new Error('403'))
    const n = await normalizeMetaMessage(
      msg({ type: 'image', image: { id: 'MID', mime_type: 'image/jpeg' } }),
      CONTACT,
      TOKEN
    )
    expect(n.mediaUrl).toBeNull()
    expect(n.contentText).toBeNull()
  })

  it('falls back to the filename for a document with no caption', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'document', document: { id: 'D', mime_type: 'application/pdf', filename: 'invoice.pdf' } }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('document')
    expect(n.contentText).toBe('invoice.pdf')
    expect(n.mediaUrl).toBe('/api/whatsapp/media/D')
  })

  it('normalizes audio with no text', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'audio', audio: { id: 'A', mime_type: 'audio/ogg' } }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('audio')
    expect(n.contentText).toBeNull()
    expect(n.mediaUrl).toBe('/api/whatsapp/media/A')
  })

  it('maps stickers to image content type', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'sticker', sticker: { id: 'S', mime_type: 'image/webp' } }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('image')
    expect(n.mediaUrl).toBe('/api/whatsapp/media/S')
  })

  it('assembles location text', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'location', location: { latitude: -23.5, longitude: -46.6, name: 'Office', address: 'Rua X' } }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('location')
    expect(n.contentText).toBe('Office - Rua X - -23.5,-46.6')
  })

  it('extracts an interactive button reply', async () => {
    const n = await normalizeMetaMessage(
      msg({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'opt_1', title: 'Existing customer' } },
      }),
      CONTACT,
      TOKEN
    )
    expect(n.contentType).toBe('interactive')
    expect(n.contentText).toBe('Existing customer')
    expect(n.interactiveReplyId).toBe('opt_1')
  })

  it('extracts an interactive list reply', async () => {
    const n = await normalizeMetaMessage(
      msg({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'row_9', title: 'Support' } },
      }),
      CONTACT,
      TOKEN
    )
    expect(n.interactiveReplyId).toBe('row_9')
    expect(n.contentText).toBe('Support')
  })

  it('normalizes a reaction into the reaction slot (no media, short-circuit marker)', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'reaction', reaction: { message_id: 'wamid.PARENT', emoji: '👍' } }),
      CONTACT,
      TOKEN
    )
    expect(n.reaction).toEqual({ targetProviderMessageId: 'wamid.PARENT', emoji: '👍' })
  })

  it('represents a reaction removal as an empty emoji', async () => {
    const n = await normalizeMetaMessage(
      msg({ type: 'reaction', reaction: { message_id: 'wamid.PARENT', emoji: '' } }),
      CONTACT,
      TOKEN
    )
    expect(n.reaction).toEqual({ targetProviderMessageId: 'wamid.PARENT', emoji: '' })
  })

  it('captures swipe-reply context', async () => {
    const n = await normalizeMetaMessage(
      msg({ text: { body: 'reply' }, context: { id: 'wamid.QUOTED' } }),
      CONTACT,
      TOKEN
    )
    expect(n.replyToProviderMessageId).toBe('wamid.QUOTED')
  })

  it('falls back to text for an unsupported type', async () => {
    const n = await normalizeMetaMessage(msg({ type: 'contacts' }), CONTACT, TOKEN)
    expect(n.contentType).toBe('text')
    expect(n.contentText).toBe('[Unsupported message type: contacts]')
  })
})
