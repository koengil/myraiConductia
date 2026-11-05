'use client';

import { createContext, createElement, useContext, useReducer, type ReactNode } from 'react';
import type { Stage, ComplianceStatus, SkillRunData } from '../api/types';

export const STAGE_ORDER: Stage[] = [
  'coldOpen',
  'intent',
  'landscape',
  'deepDive',
  'complianceTheatre',
  'pitchCta',
];

// A canvas panel is the domain SkillRunData tagged with the source skill
// (id + name). The source-skill metadata is UI-only state — it does NOT
// touch the wire contract `SkillRunData` (ADR-0005). Tagging at the
// session-store boundary lets the canvas dedupe by skillId, expose a
// remove affordance per panel, and render distinct headings for skills
// that share a `dataShape` (e.g. acquirer-fit vs deal-readiness both
// produce a compositeScore).
export interface CanvasPanel {
  skillId: string;
  skillName: string;
  data: SkillRunData;
}

export interface SessionState {
  stage: Stage;
  complianceStatus: ComplianceStatus;
  panels: CanvasPanel[];
  selectedAcquirerId: string | null;
  /**
   * The sell-side mandate the MD has opened, by company name. `null` means no
   * mandate is loaded yet — the app shows the intake (the MD names a company
   * in the command bar, compliance screens it, the mandate opens). In the
   * sandbox any input resolves to the Atlassian dataset; this string is the
   * MD's stated intent, surfaced as the active-mandate label.
   */
  mandateCompany: string | null;
}

export const initialSession: SessionState = {
  stage: 'coldOpen',
  complianceStatus: 'idle',
  panels: [],
  selectedAcquirerId: null,
  mandateCompany: null,
};

export type SessionAction =
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'ADD_PANEL'; skillId: string; skillName: string; panel: SkillRunData }
  | { type: 'REMOVE_PANEL'; skillId: string }
  | { type: 'SET_COMPLIANCE'; status: ComplianceStatus }
  | { type: 'SELECT_ACQUIRER'; id: string }
  | { type: 'SET_MANDATE'; company: string }
  | { type: 'CLEAR_MANDATE' }
  | { type: 'RESET' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'NEXT': {
      const i = STAGE_ORDER.indexOf(state.stage);
      const next = Math.min(i + 1, STAGE_ORDER.length - 1);
      return { ...state, stage: STAGE_ORDER[next] };
    }
    case 'BACK': {
      const i = STAGE_ORDER.indexOf(state.stage);
      const prev = Math.max(i - 1, 0);
      return { ...state, stage: STAGE_ORDER[prev] };
    }
    case 'ADD_PANEL': {
      // Dedupe by skillId — dropping the same skill twice is a no-op.
      if (state.panels.some((p) => p.skillId === action.skillId)) {
        return state;
      }
      return {
        ...state,
        panels: [
          ...state.panels,
          { skillId: action.skillId, skillName: action.skillName, data: action.panel },
        ],
      };
    }
    case 'REMOVE_PANEL':
      return {
        ...state,
        panels: state.panels.filter((p) => p.skillId !== action.skillId),
      };
    case 'SET_COMPLIANCE':
      return { ...state, complianceStatus: action.status };
    case 'SELECT_ACQUIRER':
      return { ...state, selectedAcquirerId: action.id };
    case 'SET_MANDATE':
      return { ...state, mandateCompany: action.company };
    case 'CLEAR_MANDATE':
      return { ...state, mandateCompany: null };
    case 'RESET':
      return initialSession;
    default:
      return state;
  }
}

interface SessionContextValue {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialSession);
  return createElement(SessionContext.Provider, { value: { state, dispatch } }, children);
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
