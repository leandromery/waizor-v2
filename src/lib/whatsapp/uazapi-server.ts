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
 * SSRF guard: is this hostname a private / loopback / link-local target we
 * must refuse? The base URL is account-admin-supplied and the server issues
 * requests to it, so we block literal internal hosts (notably the cloud
 * metadata endpoint 169.254.169.254). This is a literal-address check — it
 * does NOT resolve DNS, so a public hostname that resolves to a private IP
 * (DNS rebinding) is out of scope for this pure validator.
 */
function isBlockedHost(hostname: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal (`[::1]`); strip them.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Hostname forms that never point at a public server.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  // IPv6 literal (URL.hostname strips the surrounding brackets).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }

  // IPv4 literal.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  }

  return false;
}

/**
 * Normalize a user-entered UAZAPI base URL: trim, require an https URL,
 * reject private/loopback/link-local hosts (SSRF), strip trailing slashes.
 * Throws a user-actionable Error otherwise.
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
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(
      'UAZAPI server URL must be a public host (private, loopback, and link-local addresses are not allowed).',
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/** Build the inbound webhook callback URL UAZAPI should POST events to. */
export function uazapiWebhookUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook`;
}
