// Deal lifecycle constants. Mirror the deals.status CHECK enum in
// supabase/migrations/20260604100000_permissions_schema.sql.

export const DEAL_STATUS = {
  INTAKE: 'intake',
  ACTIVE: 'active',
  PAUSED: 'paused',
  CLOSED: 'closed',
} as const;

export type DealStatus = (typeof DEAL_STATUS)[keyof typeof DEAL_STATUS];
export const DEAL_STATUSES = Object.values(DEAL_STATUS) as DealStatus[];

// Book graduation (#191): mirror the deals.schedule_status CHECK enum in
// supabase/migrations/20260828150000_deal_fee_schedule_status.sql.
export const SCHEDULE_STATUS = {
  AHEAD: 'ahead',
  ON_TIME: 'on_time',
  LATE: 'late',
} as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUS)[keyof typeof SCHEDULE_STATUS];
export const SCHEDULE_STATUSES = Object.values(SCHEDULE_STATUS) as ScheduleStatus[];

// Book graduation (#191): mirror the deals.lifecycle_category CHECK enum in
// supabase/migrations/20260828170000_deal_lifecycle_category.sql. The
// ORDER is Storm's (Aug 27, 2026) and the Book groups deals in it.
export const LIFECYCLE_CATEGORY = {
  LIVE: 'live',
  PITCH: 'pitch',
  PROSPECT: 'prospect',
  MANDATE_HOLD: 'mandate_hold',
  TERMINATED: 'terminated',
  CLOSED: 'closed',
  LOST: 'lost',
} as const;

export type LifecycleCategory = (typeof LIFECYCLE_CATEGORY)[keyof typeof LIFECYCLE_CATEGORY];

// Storm's ruling (2026-09-01): the Book category drives the deal's working
// status. A live deal has four outcomes: it stays live, it closes and pays,
// it is terminated, or it goes inactive without being terminated (mandate
// hold). Lost belongs to the pitch workflow and also ends the work. Pitch
// and prospect carry no ruling yet and leave the status alone; 'live' only
// REACTIVATES a paused or closed deal (an intake deal is not advanced by a
// category save).
export const CATEGORY_DRIVEN_STATUS: Partial<Record<LifecycleCategory, DealStatus>> = {
  [LIFECYCLE_CATEGORY.LIVE]: DEAL_STATUS.ACTIVE,
  [LIFECYCLE_CATEGORY.CLOSED]: DEAL_STATUS.CLOSED,
  [LIFECYCLE_CATEGORY.TERMINATED]: DEAL_STATUS.CLOSED,
  [LIFECYCLE_CATEGORY.MANDATE_HOLD]: DEAL_STATUS.PAUSED,
  [LIFECYCLE_CATEGORY.LOST]: DEAL_STATUS.CLOSED,
};
export const LIFECYCLE_CATEGORIES = Object.values(LIFECYCLE_CATEGORY) as LifecycleCategory[];

/** Storm's names for the Book headings, in his order. */
export const LIFECYCLE_CATEGORY_LABEL: Record<LifecycleCategory, string> = {
  live: 'Live deals',
  pitch: 'Pitches',
  prospect: 'Prospects and client maintenance',
  mandate_hold: 'Mandate hold',
  terminated: 'Terminated',
  closed: 'Closed',
  lost: 'Lost',
};
