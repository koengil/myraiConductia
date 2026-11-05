// The checks a Graph reader registration's certificate fields must pass
// (ADR-005). Pure string validation, with no reader, token or key in reach:
// scripts/m365/write-registration.ts validates a registration with them before
// writing it, and src/lib/graph/reader/certificateSource.ts before signing.
// They sit outside the reader directory so the script never imports a reader
// (the reader fence, #262 thread T2).

export function normalizeThumbprint(thumbprint: string): string {
  const hex = thumbprint.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('The certificate thumbprint must be 40 (SHA-1) or 64 (SHA-256) hex characters');
  }
  return hex;
}

/** Key Vault hosts across the public and sovereign clouds. */
const KEY_VAULT_HOST = /^[a-z0-9-]+\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net|microsoftazure\.de)$/;

/** https://<vault>/keys/<name>/<version>, validated; the version is required so a rotation is deliberate. */
export function parseKeyVaultKeyId(keyId: string): URL {
  let url: URL;
  try {
    url = new URL(keyId);
  } catch {
    throw new Error('The Key Vault key id is not a URL');
  }
  if (url.protocol !== 'https:' || !KEY_VAULT_HOST.test(url.hostname)) {
    throw new Error('The Key Vault key id must be an https URL on a vault.azure.net host');
  }
  if (!/^\/keys\/[A-Za-z0-9-]+\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('The Key Vault key id must name /keys/<name>/<version>');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}
