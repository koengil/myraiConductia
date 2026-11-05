// A guarded surface may use the accessors, not the guard module's other doors.
import { assertMailboxAllowed } from '@/lib/mailboxAccess/guard';

export const tool = assertMailboxAllowed;
