/**
 * Server-level UAZAPI configuration.
 *
 * Unlike Meta (where every credential is per-account and user-supplied),
 * UAZAPI has a server the whole deployment talks to: a base URL and an
 * `admintoken` used once to mint each account's instance. Both are
 * operator secrets, so they live in env — an account never picks an
 * arbitrary server (the admin token wouldn't match it anyway). The
 * per-instance token minted from this server IS stored per-account
 * (encrypted) on whatsapp_config.uazapi_instance_token.
 */

export interface UazapiServer {
  baseUrl: string
  adminToken: string
}

/**
 * Read the deployment's UAZAPI server config from env. Throws a
 * user-actionable error when unset so the connect route can surface
 * "UAZAPI isn't configured on this server" rather than a vague 500.
 */
export function resolveUazapiServer(): UazapiServer {
  const baseUrl = process.env.UAZAPI_SERVER_URL?.trim().replace(/\/+$/, '')
  const adminToken = process.env.UAZAPI_ADMIN_TOKEN?.trim()
  if (!baseUrl) {
    throw new Error('UAZAPI is not configured: UAZAPI_SERVER_URL is not set.')
  }
  if (!adminToken) {
    throw new Error('UAZAPI is not configured: UAZAPI_ADMIN_TOKEN is not set.')
  }
  return { baseUrl, adminToken }
}

/** Build the inbound webhook callback URL UAZAPI should POST events to. */
export function uazapiWebhookUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook`
}
