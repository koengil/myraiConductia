export type TwinChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * How much a twin chat may send to the control plane. The chat route refuses
 * a longer `message` or `history` with 400; the client trims history to it
 * before sending (`trimTwinChatHistory`), so a long conversation keeps working
 * and the twin simply sees its most recent turns.
 */
/** Most prior turns a twin chat may replay. */
export const TWIN_CHAT_HISTORY_MAX_MESSAGES = 50;
/** Total characters across those prior turns. */
export const TWIN_CHAT_HISTORY_MAX_CHARS = 50_000;
/** Characters in the new message: the same budget as the replayed history. */
export const TWIN_CHAT_MESSAGE_MAX_CHARS = TWIN_CHAT_HISTORY_MAX_CHARS;

/**
 * The most recent turns that fit both limits, oldest first. The oldest turn
 * that would overflow the character budget is cut to what is left of it
 * rather than dropped, so a single oversize turn still reaches the twin.
 */
export function trimTwinChatHistory(history: TwinChatTurn[]): TwinChatTurn[] {
  const kept: TwinChatTurn[] = [];
  let left = TWIN_CHAT_HISTORY_MAX_CHARS;
  for (let i = history.length - 1; i >= 0 && kept.length < TWIN_CHAT_HISTORY_MAX_MESSAGES && left > 0; i -= 1) {
    const turn = history[i];
    if (turn.content.length > left) {
      kept.push({ ...turn, content: turn.content.slice(0, left) });
      break;
    }
    kept.push(turn);
    left -= turn.content.length;
  }
  return kept.reverse();
}
