'use client';

import * as React from 'react';

import {
  getLeadCatalogState,
  subscribeLeadCatalog,
  type LeadCatalogState,
} from './leadCatalog';

export function useLeadCatalog(): LeadCatalogState {
  const [state, setState] = React.useState<LeadCatalogState>(getLeadCatalogState);

  React.useEffect(() => subscribeLeadCatalog(() => setState(getLeadCatalogState())), []);

  return state;
}
