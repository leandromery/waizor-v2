/**
 * Provider registry. Picks the active provider off the account's
 * whatsapp_config row. Defaults to Meta when unset so pre-migration-036
 * rows (which have no explicit provider) resolve correctly.
 */
import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider } from './types'
import { metaProvider } from './meta'

export function getProvider(
  config: Pick<WhatsAppConfig, 'provider'>
): WhatsAppProvider {
  switch (config.provider) {
    case 'uazapi':
      // Phase 2 — implemented once the UAZAPI vendor API is wired in.
      throw new Error(
        'UAZAPI provider is not yet available. Connect via Meta, or wait for the UAZAPI integration.'
      )
    case 'meta':
    default:
      return metaProvider
  }
}

export type { WhatsAppProvider } from './types'
export * from './types'
