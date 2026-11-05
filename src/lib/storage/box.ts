import { boxEnvironmentName, getBoxClientSecret } from '@/lib/box/env';
import { boxSafeFileName, boxSafeName } from '@/lib/box/safeName';
import { DOCUMENT_ROOM, type DocumentRoom } from '@/lib/constants/documents';
import { UpstreamHttpError, upstreamErrorCode } from '@/lib/errors/upstream';
import type { DataRoomStorage, StoredObject } from './types';

const API = 'https://api.box.com/2.0';
const UPLOAD_API = 'https://upload.box.com/api/2.0';
const ROOT_FOLDER = '0';
const TREE_ROOT = 'Conductia';

// Box folder names per room. The tree /Conductia/{dealCode}/{internal|dealroom}
// mirrors the room split as defense-in-depth; access control never reads it.
const ROOM_FOLDER: Record<DocumentRoom, string> = {
  [DOCUMENT_ROOM.INTERNAL]: 'internal',
  [DOCUMENT_ROOM.DEAL]: 'dealroom',
};

// A Box failure carries the status and Box's error code, never a body or a name.
async function boxFailure(op: string, res: Response): Promise<UpstreamHttpError> {
  return new UpstreamHttpError('box', op, res.status, await upstreamErrorCode(res), res.headers.get('box-request-id'));
}

interface BoxEntry {
  id: string;
  name?: string;
  size?: number;
}

// Conductia-mediated Box provider. Auth: BOX_DEV_TOKEN when present (demo
// tenant), else client-credentials grant (BOX_CLIENT_ID + BOX_SECRET +
// BOX_ENTERPRISE_ID). Uses raw fetch — the Box REST surface we need is three
// endpoints; no SDK dependency.
export class BoxStorage implements DataRoomStorage {
  readonly provider = 'box' as const;

  private token: { value: string; expiresAt: number } | null = null;
  private folderCache = new Map<string, string>();

  private async accessToken(): Promise<string> {
    const devToken = process.env.BOX_DEV_TOKEN;
    if (devToken) return devToken;

    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }

    const clientId = process.env.BOX_CLIENT_ID;
    const secret = getBoxClientSecret();
    const enterpriseId = process.env.BOX_ENTERPRISE_ID;
    if (!clientId || !secret || !enterpriseId) {
      throw new Error(
        'Box auth requires BOX_DEV_TOKEN, or BOX_CLIENT_ID + BOX_SECRET + BOX_ENTERPRISE_ID',
      );
    }

    const res = await fetch('https://api.box.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        box_subject_type: 'enterprise',
        box_subject_id: enterpriseId,
      }),
    });
    if (!res.ok) {
      throw await boxFailure('token', res);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.token.value;
  }

  private async ensureFolder(parentId: string, rawName: string): Promise<string> {
    // Second line of defense (#328): every folder name sent to Box is safe.
    const name = boxSafeName(rawName);
    const cacheKey = `${parentId}/${name}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return cached;

    const token = await this.accessToken();
    const res = await fetch(`${API}/folders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, parent: { id: parentId } }),
    });

    let id: string;
    if (res.status === 409) {
      // An unreadable body is a missing conflict, not a thrown SyntaxError:
      // V8 quotes the start of the text it could not parse.
      const conflict = (await res
        .clone()
        .json()
        .catch(() => ({}))) as {
        context_info?: { conflicts?: BoxEntry[] };
      };
      const existing = conflict.context_info?.conflicts?.[0]?.id;
      if (!existing) {
        // The folder name is deal content; the error names the status and code only.
        throw await boxFailure('createFolder', res);
      }
      id = existing;
    } else if (res.ok) {
      id = ((await res.json()) as BoxEntry).id;
    } else {
      throw await boxFailure('createFolder', res);
    }

    this.folderCache.set(cacheKey, id);
    return id;
  }

  private async roomFolderId(dealCode: string, room: DocumentRoom): Promise<string> {
    const envRootId = await this.ensureFolder(ROOT_FOLDER, boxEnvironmentName());
    const conductiaId = await this.ensureFolder(envRootId, TREE_ROOT);
    const dealId = await this.ensureFolder(conductiaId, dealCode);
    return this.ensureFolder(dealId, ROOM_FOLDER[room]);
  }

  /** Pre-create /Conductia/{dealCode}/{internal|dealroom} at deal birth. */
  async ensureDealFolders(dealCode: string): Promise<void> {
    await this.roomFolderId(dealCode, DOCUMENT_ROOM.INTERNAL);
    await this.roomFolderId(dealCode, DOCUMENT_ROOM.DEAL);
  }

  async upload(
    dealCode: string,
    room: DocumentRoom,
    name: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<StoredObject> {
    const folderId = await this.roomFolderId(dealCode, room);
    const token = await this.accessToken();

    // Unique stored name: users never see Box, so uniqueness beats prettiness.
    // The whole name goes through boxSafeFileName so the prefix counts toward
    // the 255-character cap and the extension survives truncation (#328).
    const storedName = boxSafeFileName(`${crypto.randomUUID().slice(0, 8)}-${name}`);
    const form = new FormData();
    form.append(
      'attributes',
      JSON.stringify({ name: storedName, parent: { id: folderId } }),
    );
    form.append('file', new Blob([bytes as BlobPart], { type: contentType }), storedName);

    const res = await fetch(`${UPLOAD_API}/files/content`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) {
      throw await boxFailure('upload', res);
    }
    const json = (await res.json()) as { entries: BoxEntry[] };
    const entry = json.entries[0];
    if (!entry) {
      throw new UpstreamHttpError('box', 'upload', res.status, 'no_file_entry');
    }
    return {
      provider: this.provider,
      fileId: entry.id,
      sizeBytes: entry.size ?? bytes.byteLength,
    };
  }

  async downloadStream(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const token = await this.accessToken();
    const res = await fetch(`${API}/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) {
      throw await boxFailure('download', res);
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  async remove(fileId: string): Promise<void> {
    const token = await this.accessToken();
    await fetch(`${API}/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
