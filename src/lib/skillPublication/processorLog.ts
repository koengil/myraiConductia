export function logProcessorEvent(
  publicationId: string,
  state: string,
  reasonCode: string | null,
  correlationId: string,
): void {
  console.log(
    JSON.stringify({
      publicationId,
      state,
      reasonCode,
      correlationId,
    }),
  );
}
