/**
 * Provider registry. Picks the active provider off the account's
 * whatsapp_config row. Defaults to Meta when unset so pre-migration-036
 * rows (which have no explicit provider) resolve correctly.
 */
import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider } from './types'
import { metaProvider } from './meta'
import { uazapiProvider } from './uazapi'

export function getProvider(
  config: Pick<WhatsAppConfig, 'provider'>
): WhatsAppProvider {
  switch (config.provider) {
    case 'uazapi':
      return uazapiProvider
    case 'meta':
    default:
      return metaProvider
  }
}

export type { WhatsAppProvider } from './types'
export * from './types'
