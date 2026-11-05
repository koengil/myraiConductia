import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

/*
 * The fixture Data Room (platform_onboarding off) has no invite form,
 * so a Mail "Give data room access" handoff is cleared on mount instead of
 * lingering in memory.
 */

vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'ZZ-A' }) }));
vi.mock('@/components/dataroom/DataRoom', () => ({ DataRoom: () => <p>Fixture room</p> }));
vi.mock('@/components/dataroom/DataRoomLive', () => ({ DataRoomLive: () => <p>Live room</p> }));

import { DataRoomSwitch } from '@/components/dataroom/DataRoomSwitch';
import { clearRecipientAddition, peekRecipientAddition, queueRecipientAddition } from '@/lib/team/recipientAddition';

afterEach(() => {
  cleanup();
  clearRecipientAddition();
});

it('clears the data room handoff when the fixture room mounts', () => {
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomSwitch />);
  expect(peekRecipientAddition('ZZ-A', 'data-room')).toBeNull();
});

it('leaves a Team handoff alone', () => {
  queueRecipientAddition('ZZ-A', 'col@firm.test', 'team');
  render(<DataRoomSwitch />);
  expect(peekRecipientAddition('ZZ-A', 'team')).toBe('col@firm.test');
});
