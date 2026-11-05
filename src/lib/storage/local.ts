import { errorCodeOf } from '@/lib/errors/upstream';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { DocumentRoom } from '@/lib/constants/documents';
import type { DataRoomStorage, StoredObject } from './types';

const BUCKET = 'dataroom';

// Credential-free-Box provider for dev/CI: same seam, Supabase Storage bytes.
// Paths are {dealCode}/{room}/{uuid}-{name}, so the room split is preserved
// on disk as defense-in-depth (the wall itself lives in the predicates).
export class LocalStorage implements DataRoomStorage {
  readonly provider = 'local' as const;

  async ensureDealFolders(_dealCode: string): Promise<void> {
    // Paths are created on first upload; nothing to pre-provision.
  }

  buildPath(dealCode: string, room: DocumentRoom, name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${dealCode}/${room}/${crypto.randomUUID()}-${safeName}`;
  }

  async upload(
    dealCode: string,
    room: DocumentRoom,
    name: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<StoredObject> {
    const path = this.buildPath(dealCode, room, name);
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType,
      upsert: false,
    });
    if (error) {
      throw new Error(`local storage upload failed (${errorCodeOf(error)})`);
    }
    return { provider: this.provider, fileId: path, sizeBytes: bytes.byteLength };
  }

  async downloadStream(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage.from(BUCKET).download(fileId);
    if (error || !data) {
      throw new Error(`local storage download failed (${error ? errorCodeOf(error) : 'no_data'})`);
    }
    return data.stream() as ReadableStream<Uint8Array>;
  }

  async remove(fileId: string): Promise<void> {
    const supabase = createSupabaseAdminClient();
    await supabase.storage.from(BUCKET).remove([fileId]);
  }
}
