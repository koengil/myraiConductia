// A constant that re-exports a mailbox-derived table name. It sits outside
// tables.ts and discovery.ts, so it is not exempt.
import { TABLE } from '@/lib/constants/tables';

export const ITEMS = TABLE.SOURCE_ITEMS; // FLAG
