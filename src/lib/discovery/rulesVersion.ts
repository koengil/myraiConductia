import { LEXICON_VERSION } from '@/lib/compliance/lexicon';

/**
 * Names the rules that processed a message, in the message index (#461, design entry 19) and in #501's
 * content-tag style. Bump the date when routing (route/firmRules.ts) or the screen's rules
 * (compliance/screen.ts) change; the lexicon carries its own version. A message indexed under another
 * version is processed again when it is read again (the skip rule, design entry 20).
 */
export const DISCOVERY_RULES_VERSION = `rules-2026-10-22b+lexicon-${LEXICON_VERSION}`;
