/**
 * UAZAPI server helpers.
 *
 * The UAZAPI server (base URL + admin token) is configured per-account
 * now, not via deployment env — so the credential resolution lives in the
 * connect route against the account's whatsapp_config row. This module
 * keeps two pure helpers: validating a user-entered base URL, and building
 * OUR inbound webhook callback URL.
 */

/**
 * Normalize a user-entered UAZAPI base URL: trim, require an https URL,
 * strip trailing slashes. Throws a user-actionable Error otherwise.
 */
export function normalizeUazapiBaseUrl(input: string): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) {
    throw new Error('UAZAPI server URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('UAZAPI server URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('UAZAPI server URL must start with https://.');
  }
  return trimmed.replace(/\/+$/, '');
}

/** Build the inbound webhook callback URL UAZAPI should POST events to. */
export function uazapiWebhookUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook`;
}
