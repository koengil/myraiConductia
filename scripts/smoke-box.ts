import { BoxStorage } from '../src/lib/storage/box';
import { DOCUMENT_ROOM } from '../src/lib/constants/documents';

// Manual Box smoke test (CI has no Box credentials — run locally):
//   npm run smoke:box
// Uploads a small file into both rooms of a throwaway deal folder, streams it
// back, verifies bytes round-trip, then deletes both files.
async function main(): Promise<void> {
  const box = new BoxStorage();
  const dealCode = `SMOKE-${Date.now()}`;
  const payload = new TextEncoder().encode(`conductia box smoke ${dealCode}`);

  for (const room of [DOCUMENT_ROOM.INTERNAL, DOCUMENT_ROOM.DEAL]) {
    const stored = await box.upload(dealCode, room, 'smoke.txt', 'text/plain', payload);
    console.log(`↑ ${room}: file ${stored.fileId} (${stored.sizeBytes} bytes)`);

    const stream = await box.downloadStream(stored.fileId);
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    if (new TextDecoder().decode(buf) !== new TextDecoder().decode(payload)) {
      throw new Error(`round-trip mismatch in room ${room}`);
    }
    console.log(`↓ ${room}: round-trip OK`);

    await box.remove(stored.fileId);
    console.log(`✕ ${room}: deleted`);
  }

  console.log('✅ Box smoke passed. Throwaway folder left in Box:', dealCode);
}

main().catch((err) => {
  console.error('❌ Box smoke failed:', err);
  process.exit(1);
});
