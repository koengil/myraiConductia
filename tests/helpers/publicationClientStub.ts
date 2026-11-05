import { vi } from "vitest";
import type { createPublicationOperations } from "@/lib/skillAuthoring/publicationClient";

export function publicationClientStub(): ReturnType<
  typeof createPublicationOperations
> {
  const notStubbed = () => {
    throw new Error("publication client not stubbed for this test");
  };
  return {
    publish: vi.fn(notStubbed),
    decideDuplicate: vi.fn(notStubbed),
    replacePlacement: vi.fn(notStubbed),
  };
}
