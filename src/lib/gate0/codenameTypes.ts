/** Masked picks shown when a theme chip is selected. */
export const CODENAME_SUGGESTIONS_PER_THEME = 5;

/** One themed set of Gate 0 code-name suggestions. */
export type CodenameThemeProposal = {
  /** Stable slug for React keys (theme label slugified). */
  id: string;
  /** Human-readable theme the MD picked (stored on the deal as codenameTheme). */
  label: string;
  /** Five "Project …" names that mask the target company. */
  suggestions: string[];
};

export type CodenameSuggestResult = {
  themes: CodenameThemeProposal[];
  source: 'llm' | 'fallback';
};
