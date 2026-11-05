// The query keys that carry free text and never ride in an app URL (#331); the content-egress guard uses the same set.
export const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'query',
  'q',
  'person',
  'search',
  'prompt',
  'text',
  'message',
  'name',
  'path',
  'file',
  'filename',
  'title',
  'subject',
  'email',
  'term',
  'keyword',
]);
