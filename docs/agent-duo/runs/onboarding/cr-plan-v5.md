---
run_id: onboarding
type: review
status: approved
round: 5
source: plan-v5.md
---

# Review: `plan-v5.md`

## 1. Coverage of every frozen-spec acceptance criterion

I re-reviewed only the v4→v5 diff and prior finding 1.1. The revision restores
`generateLink` metadata to
`{invite_id, is_external, tenant_id}`, with all values sourced from the
authoritative invite row (`plan-v5.md:147-155,328-336`). This exactly preserves
the approved brief's untouched-trigger and `is_external` metadata contract
(`brief.md:62-64`) while also supplying the `tenant_id` consumed by the
existing trigger
(`supabase/migrations/20260604100000_permissions_schema.sql:173-178`).
Finding 1.1 is resolved, and the diff introduces no acceptance-criterion gap.

## 2. Scope discipline

The substantive v5 change is limited to restoring the omitted identity
metadata and extending its verification; the remaining edits are round/change
annotations (`plan-v5.md:15-20,68-74,147-155,328-336`). It does not alter
roles, permissions, invite lifecycle, UI scope, or another previously reviewed
milestone. The repair stays within the frozen onboarding scope.

## 3. Migration and rollback

The trigger remains untouched, so the diff adds no schema migration or rollback
surface. Instead, it exercises the existing trigger contract and adds a parity
test proving internal and external invite identities receive the correct
`is_external` classification before delivery
(`plan-v5.md:68-74`). The previously approved migration and rollback ordering
is unchanged.

## 4. Edge cases

The extended parity test covers both values of the corrected classification,
not only the external happy path (`plan-v5.md:68-72,330-336`). Metadata comes
from the invite row rather than client input, and the existing abort-before-send
containment sequence remains unchanged (`plan-v5.md:149-164`). This resolves
the temporary external-as-internal profile edge case without reopening the
previous duplicate-scope or delivery-finalization findings.

## 5. Technical and security soundness

The changed design is technically sound: the untouched trigger already reads
`tenant_id` and `is_external` from auth metadata, and v5 now supplies both
as server-owned values before the mirror insert
(`plan-v5.md:150-158`;
`supabase/migrations/20260604100000_permissions_schema.sql:173-178`).
The server-owned `status='invited'` containment step remains separate from
identity classification. The v4→v5 diff does not change the previously approved
server-side predicates that deny external users every Internal-room and
class-4 MNPI document path (`plan-v5.md:220-234`). No security, race,
audit, or data-loss blocker remains.
