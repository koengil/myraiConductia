/**
 * Box Content API client (Client Credentials Grant).
 * https://developer.box.com/guides/authentication/client-credentials/
 */

import { UpstreamHttpError, upstreamErrorCode } from '@/lib/errors/upstream';
import type { BoxClient, BoxConfig, BoxFile } from './types';

// A Box failure carries the status and Box's error code, never the response
// body: a body can quote a file or folder name, and the name is deal content.
async function boxFailure(op: string, res: Response): Promise<UpstreamHttpError> {
  return new UpstreamHttpError('box', op, res.status, await upstreamErrorCode(res), res.headers.get('box-request-id'));
}

type TokenCache = { accessToken: string; expiresAtMs: number };

let tokenCache: TokenCache | null = null;

async function fetchAccessToken(config: BoxConfig): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 60_000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    box_subject_type: 'enterprise',
    box_subject_id: config.enterpriseId,
  });

  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw await boxFailure('token', res);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: json.access_token,
    expiresAtMs: now + json.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

function boxFileFromEntry(entry: {
  id: string;
  name: string;
  size?: number;
  created_at?: string;
}): BoxFile {
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size ?? 0,
    createdAt: entry.created_at ?? new Date().toISOString(),
    url: `https://app.box.com/file/${entry.id}`,
  };
}

export function createBoxClient(config: BoxConfig): BoxClient {
  async function authHeaders(): Promise<HeadersInit> {
    const token = await fetchAccessToken(config);
    return { Authorization: `Bearer ${token}` };
  }

  return {
    async createFolder(name, parentFolderId) {
      const headers = await authHeaders();
      const res = await fetch('https://api.box.com/2.0/folders', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, parent: { id: parentFolderId } }),
      });

      if (res.status === 409) {
        // An unreadable body is a missing conflict, not a thrown SyntaxError:
        // V8 quotes the start of the text it could not parse.
        const conflict = (await res
          .clone()
          .json()
          .catch(() => ({}))) as {
          context_info?: { conflicts?: Array<{ id: string; name?: string }> };
        };
        const existing = conflict.context_info?.conflicts?.[0];
        if (!existing?.id) {
          // The folder name is deal content; the error names the status and code only.
          throw await boxFailure('createFolder', res);
        }
        return {
          id: existing.id,
          name: existing.name ?? name,
          url: `https://app.box.com/folder/${existing.id}`,
        };
      }

      if (!res.ok) {
        throw await boxFailure('createFolder', res);
      }

      const json = (await res.json()) as { id: string; name: string };
      return {
        id: json.id,
        name: json.name,
        url: `https://app.box.com/folder/${json.id}`,
      };
    },

    async listFolderItems(folderId) {
      const headers = await authHeaders();
      const res = await fetch(
        `https://api.box.com/2.0/folders/${folderId}/items?fields=id,name,size,created_at,type&limit=1000`,
        { headers },
      );

      if (!res.ok) {
        throw await boxFailure('listFolderItems', res);
      }

      const json = (await res.json()) as {
        entries?: Array<{ type: string; id: string; name: string; size?: number; created_at?: string }>;
      };

      return (json.entries ?? [])
        .filter((entry) => entry.type === 'file')
        .map(boxFileFromEntry);
    },

    async uploadFile(folderId, fileName, content) {
      const headers = await authHeaders();
      const form = new FormData();
      form.append(
        'attributes',
        JSON.stringify({ name: fileName, parent: { id: folderId } }),
      );
      form.append('file', new Blob([new Uint8Array(content)]), fileName);

      const res = await fetch('https://upload.box.com/api/2.0/files/content', {
        method: 'POST',
        headers,
        body: form,
      });

      if (!res.ok) {
        throw await boxFailure('uploadFile', res);
      }

      const json = (await res.json()) as {
        entries?: Array<{ id: string; name: string; size?: number; created_at?: string }>;
      };
      const entry = json.entries?.[0];
      if (!entry) {
        throw new UpstreamHttpError('box', 'uploadFile', res.status, 'no_file_entry');
      }
      return boxFileFromEntry(entry);
    },

    async deleteFile(fileId) {
      const headers = await authHeaders();
      const res = await fetch(`https://api.box.com/2.0/files/${fileId}`, {
        method: 'DELETE',
        headers,
      });
      // 404: already gone, which is the outcome the caller wants.
      if (!res.ok && res.status !== 404) {
        throw await boxFailure('deleteFile', res);
      }
    },
  };
}
