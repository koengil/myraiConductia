# Permissions Schema — v1 (draft)

**Purpose.** The shared model both the prototype UI and the secure backend build against. This is the *model* (entities + who-sees-what + audit), not the enforcement code. Target platform: Supabase / Postgres.

**Core principle.** Access is **deal-scoped by default**. If a user has no membership in a deal, that deal does not exist for them — no listing, no search, no documents. This is the Chinese wall, enforced by construction rather than by policy. The only roles that sit *above* the walls are compliance (oversight) and admin.

---

## 1. Entities

```sql
-- Companies: parties involved in deals (target, client, counterparty)
create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null check (type in ('target','client','counterparty')),
  created_at  timestamptz not null default now()
);

-- Deals: the unit of isolation. `code` is the project code minted at intake.
create table deals (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,          -- e.g. "ATLAS-2026-014"
  codename          text not null,                 -- e.g. "Project Atlas"
  target_company_id uuid references companies(id),
  status            text not null default 'intake' -- intake | active | closed
                    check (status in ('intake','active','closed')),
  created_at        timestamptz not null default now()
);

-- Users: internal staff and external parties live in one table.
create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text not null,
  is_external boolean not null default false,
  -- Firm-wide roles that cross deal boundaries. NULL for everyone else.
  firm_role   text check (firm_role in ('compliance','admin')),
  status      text not null default 'active'       -- active | suspended
);

-- Deal memberships: the access grant. Presence here = inside the wall.
create table deal_memberships (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references deals(id),
  user_id    uuid not null references users(id),
  deal_role  text not null check (deal_role in ('md','deal_team','seller','buyer')),
  phase      int  not null default 0,              -- buyer data-room phase gate
  added_by   uuid references users(id),
  added_at   timestamptz not null default now(),
  unique (deal_id, user_id)
);

-- Documents: classification drives routing tier and can further gate access.
create table documents (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references deals(id),
  name           text not null,
  classification int  not null check (classification between 1 and 4), -- 1 Public … 4 MNPI
  min_phase      int  not null default 0,           -- earliest buyer phase that may see it
  uploaded_by    uuid references users(id),
  created_at     timestamptz not null default now()
);
```

---

## 2. Access matrix (who-sees-what)

| Role | Scope | Rights |
|---|---|---|
| **MD** | assigned deals only | full read + write within the deal |
| **Deal team** | assigned deals only | read + write within the deal |
| **Seller** (external) | one assigned deal | **upload only** — cannot read others' content |
| **Buyer** (external) | one assigned deal | read, gated by `phase` (sees a document only if `doc.min_phase <= membership.phase`) |
| **Compliance** | all deals | read + full audit access (oversight, above the walls) |
| **Admin** | none (deal content) | manage users / memberships; no deal content by default |

The governing rule: **visibility = membership scope ∩ classification policy.** Membership decides *which deals*; classification decides *which documents within them and how they route* (Class 4 / MNPI → on-prem tier, per the gateway).

---

## 3. Audit shape

Every read, write, upload, export, and permission change is recorded — this is the spine of the compliance story, not an add-on.

```sql
create table audit_log (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  actor_id     uuid not null references users(id),
  action       text not null,        -- view | download | upload | export | grant | revoke | route
  deal_id      uuid references deals(id),
  document_id  uuid references documents(id),
  detail       jsonb                 -- e.g. {"classification":4,"tier":"on-prem"}
);
```

---

## 4. Enforcement (derived — backend lane, not part of the model)

For reference, this is how the model maps to Supabase RLS so the seams line up later:

```sql
-- A deal is visible if you're a member, or you hold an oversight firm_role.
create policy deal_visibility on deals for select using (
  exists (select 1 from deal_memberships m
          where m.deal_id = deals.id and m.user_id = auth.uid())
  or exists (select 1 from users u
             where u.id = auth.uid() and u.firm_role in ('compliance','admin'))
);
```

Documents inherit deal visibility, with buyer phase + classification layered on top.

---

## 5. Decisions to confirm (don't want to invent these)

1. **MD scope.** Modeled here as deal-scoped (an MD sees only deals they're walled into), not firm-wide. This is the info-barrier-safe reading and the one a FINRA reviewer would expect — but the 24th said "full project access," so confirm that means *within assigned deals*, not *all deals*.
2. **Buyer phases.** `phase` is an integer gate; we need the actual phase ladder (e.g. 0 = teaser, 1 = NDA-signed data room, 2 = confirmatory). What are the stages?
3. **Companies per deal.** Modeled as one `target_company_id`. If we need to track client + counterparty parties per deal, this becomes a `deal_parties` join — confirm whether that's in scope for v1.
4. **Classification vs. visibility.** Confirmed that class drives *routing*. Open question: should class also *hide* documents from some in-deal roles (e.g. Class 4 hidden from external parties entirely), or only route them?