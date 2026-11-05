import {
  PERSON_SUGGESTION_SOURCE,
  type PersonSuggestion,
  type PersonSuggestionSource,
} from '@/lib/people/types';

export function formatPersonSuggestionLabel(
  suggestion: PersonSuggestion,
  mode: 'person' | 'email',
): string {
  if (mode === 'email' && suggestion.email) return suggestion.email;
  return suggestion.name;
}

export function personSuggestionSourceLabel(source: PersonSuggestionSource): string {
  switch (source) {
    case PERSON_SUGGESTION_SOURCE.DEAL_MEMBER:
      return 'Deal team';
    case PERSON_SUGGESTION_SOURCE.COMPANY_USER:
      return 'Company';
    case PERSON_SUGGESTION_SOURCE.RELATIONSHIP:
      return 'Relationship';
    case PERSON_SUGGESTION_SOURCE.STAKEHOLDER:
      return 'Stakeholder';
    default:
      return 'Contact';
  }
}
