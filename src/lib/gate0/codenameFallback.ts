import {
  CODENAME_THEME_IDS,
  CODENAME_THEME_LABELS,
  proposeCodenamesByTheme,
  type SearchableCompany,
} from '@/lib/rail/deals';

import {
  CODENAME_SUGGESTIONS_PER_THEME,
  type CodenameSuggestResult,
  type CodenameThemeProposal,
} from './codenameTypes';

/** Deterministic Birds / Football / Movies themes — the pre-LLM default. */
export function fallbackCodenameThemes(
  company: SearchableCompany,
  offset = 0,
): CodenameSuggestResult {
  const themes: CodenameThemeProposal[] = CODENAME_THEME_IDS.map((id) => ({
    id,
    label: CODENAME_THEME_LABELS[id],
    suggestions: proposeCodenamesByTheme(
      id,
      company,
      CODENAME_SUGGESTIONS_PER_THEME,
      offset,
    ),
  }));
  return { themes, source: 'fallback' };
}
