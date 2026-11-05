/**
 * The JSON object inside a model reply: a fenced block, else the outermost
 * braces, else the trimmed text. Shared by every caller that asks for JSON.
 */
export function extractJsonPayload(reply: string): string {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start >= 0 && end > start) return reply.slice(start, end + 1);
  return reply.trim();
}
