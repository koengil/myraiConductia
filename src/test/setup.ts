import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Testing Library's own 1s ceiling on findBy*/waitFor is independent of
// vitest's testTimeout, and the census renders overrun it under parallel load.
configure({ asyncUtilTimeout: 5000 });

// No test reaches the AI Gateway by accident (#462): a developer shell or CI secret holding a key would
// turn a unit run into a paid, live call. A test that needs the key path stubs it with vi.stubEnv, which
// restores this blank afterwards.
process.env.AI_GATEWAY_API_KEY = '';
