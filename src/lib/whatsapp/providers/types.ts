/**
 * Provider abstraction for WhatsApp backends.
 *
 * Two providers exist today:
 *   - 'meta'   — the official Meta Cloud API (wraps meta-api.ts)
 *   - 'uazapi' — an unofficial, session-based API paired via QR code
 *
 * An account uses ONE provider at a time (whatsapp_config.provider).
 * Everything downstream of "send a message" / "a message arrived" is
 * provider-agnostic; this interface is the seam where the two differ.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppConfig, WhatsAppProviderId, MessageTemplate } from '@/types'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'

/**
 * Everything a provider needs to perform an outbound send. Providers
 * pull the credentials they need off `config` (and decrypt them). `db`
 * is passed so a provider can persist credential upkeep — e.g. the Meta
 * provider's legacy-ciphertext self-heal.
 */
export interface OutboundContext {
  config: WhatsAppConfig
  db: SupabaseClient
}

export interface SendTextInput {
  to: string
  text: string
  /** Provider message id being replied to (swipe-reply / quote). */
  contextMessageId?: string
}

export interface SendMediaInput {
  to: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendInteractiveInput {
  to: string
  payload: InteractiveMessagePayload
  contextMessageId?: string
}

/**
 * Template sends are a Meta-only concept (WABA approval lifecycle), so
 * this input is Meta-shaped and `sendTemplate` is an optional member of
 * the interface — providers whose `capabilities.templates` is false do
 * not implement it.
 */
export interface SendTemplateInput {
  to: string
  templateName: string
  language?: string
  /** Legacy body-only params. */
  params?: string[]
  /** Template row (for header + button components). */
  template?: MessageTemplate
  /** Structured send-time params (header media, button params, …). */
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendResult {
  messageId: string
}

/**
 * Drives feature gating in the composer, send API, and Settings UI.
 * Meta supports everything; UAZAPI (session-based) has no template
 * approval concept, so `templates` is false for it.
 */
export interface ProviderCapabilities {
  templates: boolean
  interactive: boolean
  broadcast: boolean
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId
  readonly capabilities: ProviderCapabilities

  sendText(ctx: OutboundContext, input: SendTextInput): Promise<SendResult>
  sendMedia(ctx: OutboundContext, input: SendMediaInput): Promise<SendResult>
  sendInteractive(
    ctx: OutboundContext,
    input: SendInteractiveInput
  ): Promise<SendResult>

  /**
   * Template send. Optional — only implemented by providers whose
   * `capabilities.templates` is true (Meta). Callers must gate on the
   * capability before invoking.
   */
  sendTemplate?(
    ctx: OutboundContext,
    input: SendTemplateInput
  ): Promise<SendResult>

  // Inbound normalization and connection lifecycle (QR) are added by
  // their respective providers in later phases — see the design spec,
  // docs/superpowers/specs/2026-07-13-whatsapp-uazapi-provider-design.md
}
