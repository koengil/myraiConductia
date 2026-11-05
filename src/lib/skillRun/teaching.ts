import type { OutputChain } from './revisionStore';
import { parseRevisionInputs } from './revisions';

export type TeachableComment = {
  revisionId: string;
  editId: string;
  comment: string;
  passage: string;
  became: string;
};

export const COMPOSER_LIMIT = 20_000;
export const TEACHING_EXCERPT_LENGTH = 600;

const HEADER =
  'Update this skill with lessons from reviews of its output.\n\n' +
  'Keep the lessons in a section titled "Learned from reviews". Merge these with any lessons already in that section: drop duplicates, and where two conflict, keep the newer one. Write each lesson as a short standing rule. State each lesson in general terms: do not name the company, any party, codename or person, and do not repeat a figure from the comments or excerpts below. Leave every other part of the skill unchanged.';

export function teachableComments(chain: OutputChain, sent: ReadonlySet<string>): TeachableComment[] {
  const found: TeachableComment[] = [];
  for (const row of chain.rows) {
    if (row.outcome !== 'succeeded') continue;
    const inputs = parseRevisionInputs(row.inputs);
    if (inputs?.kind !== 'edits') continue;
    const own = chain.versions.find((version) => version.id === row.id);
    const parent = chain.versions.find((version) => version.id === row.parentId);
    if (!own || !parent) continue;
    for (const edit of inputs.edits) {
      if (edit.kind !== 'comment' || edit.teach !== true || edit.status !== 'applied') continue;
      if (edit.comment === undefined || edit.resultStart === undefined || edit.resultEnd === undefined) continue;
      if (sent.has(edit.id)) continue;
      found.push({
        revisionId: row.id,
        editId: edit.id,
        comment: edit.comment,
        passage: parent.text.slice(edit.start, edit.end),
        became: own.text.slice(edit.resultStart, edit.resultEnd),
      });
    }
  }
  return found;
}

export function promptRoom(composerText: string): number {
  return COMPOSER_LIMIT - composerText.length - (composerText === '' ? 0 : 2);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TEACHING_EXCERPT_LENGTH) return flat;
  const last = flat.charCodeAt(TEACHING_EXCERPT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? TEACHING_EXCERPT_LENGTH - 1 : TEACHING_EXCERPT_LENGTH;
  return `${flat.slice(0, end)}...`;
}

export function teachingPrompt(
  comments: readonly TeachableComment[],
  room: number,
): { text: string; included: TeachableComment[] } {
  const included: TeachableComment[] = [];
  let text = HEADER;
  for (const item of comments) {
    const entry =
      `${included.length + 1}. Comment: "${item.comment}"\n` +
      `   Written on: "${excerpt(item.passage)}"\n` +
      `   Became: "${excerpt(item.became)}"`;
    const next = `${text}\n\n${entry}`;
    if (next.length > room) break;
    text = next;
    included.push(item);
  }
  return { text: included.length === 0 ? '' : text, included };
}
