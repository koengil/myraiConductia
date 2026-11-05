import type { DocumentRoom } from '@/lib/constants/documents';

// The data-room storage seam (ADR pending, plan-v5 M2). Implementations move
// bytes only — every access decision (room wall, phase, classification) stays
// in the app-layer predicates. The seam is room-aware so a caller can never
// route internal-room bytes into an externally reachable location: the folder
// or path is derived server-side from (dealCode, room), never client-supplied.

export interface StoredObject {
  provider: StorageProviderName;
  /** Provider-scoped opaque id (Box file id, or bucket path for local). */
  fileId: string;
  sizeBytes: number;
}

export type StorageProviderName = 'local' | 'box';

export interface DataRoomStorage {
  readonly provider: StorageProviderName;
  /** Create provider-side deal folders when a deal is born. No-op for local. */
  ensureDealFolders(dealCode: string): Promise<void>;
  upload(
    dealCode: string,
    room: DocumentRoom,
    name: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<StoredObject>;
  downloadStream(fileId: string): Promise<ReadableStream<Uint8Array>>;
  /** Compensation primitive: best-effort delete after a failed DB finalize. */
  remove(fileId: string): Promise<void>;
}
