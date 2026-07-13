/**
 * Provider-agnostic inbound message shape.
 *
 * Each provider's inbound webhook parses its own payload (and resolves
 * media) into this normalized form, which the shared inbound processor
 * (process.ts) consumes. Adding a new provider means writing a new
 * normalizer — the processor never changes.
 */

/** DB `content_type` values allowed by the messages table CHECK. */
export type NormalizedContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'interactive'

export interface NormalizedReaction {
  /** Provider message id of the message being reacted to. */
  targetProviderMessageId: string
  /** Emoji; empty string means the reaction was removed. */
  emoji: string
}

export interface NormalizedInbound {
  /** The provider's own message id (Meta wamid, UAZAPI id, …). */
  providerMessageId: string
  /** Sender phone, already run through normalizePhone. */
  fromPhone: string
  /** Display name from the provider's contact profile (may be empty). */
  contactName: string
  /** Unix seconds the provider stamped on the message. */
  timestampSeconds: number
  /** Original provider type label — drives the `[type]` list preview. */
  typeLabel: string
  /** DB content_type, already mapped to the allowed set above. */
  contentType: NormalizedContentType
  contentText: string | null
  /** Already-resolved, storable media URL (proxy path or hosted URL). */
  mediaUrl: string | null
  /** Stable id of a tapped interactive button/list row, else null. */
  interactiveReplyId: string | null
  /** Provider message id this is a swipe-reply to, else null. */
  replyToProviderMessageId: string | null
  /**
   * Present ONLY for reactions. Reactions short-circuit in the processor
   * (no `messages` row is written) — see process.ts.
   */
  reaction: NormalizedReaction | null
}
