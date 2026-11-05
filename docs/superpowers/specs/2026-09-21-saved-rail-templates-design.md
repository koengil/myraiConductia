# Saved rail templates

Status: product behavior confirmed in the conversation; implementation design recorded on 2026-09-21. Implementation has not started.

## Product contract

A banker saves the active shape of a deal's rail under a name. Other people in the same company can select it when creating a deal, without membership in the source deal. Saving offers **Create new** or **Replace existing**. Replacement changes the template used by future creations; it never edits an existing project's rail or skills.

The user explicitly confirmed company-wide reuse, the selected skill version, replacement semantics, and clearing named people. The implementation choices below make those decisions executable; they do not add automatic propagation or a general skill marketplace.

### Global constraints

- Keep the 61-step standard rail selected by default in Gate 0.
- Templates belong to one bank company and tenant; template use does not grant access to the source deal.
- Save and replace require internal source-deal access and `company:deals:steps:structure` on that deal's bank company.
- List and use require internal company membership and the existing authority to create deals in that company; source-deal membership is unnecessary.
- Save active steps in their current order, including completed and skipped steps; exclude removed steps.
- Copy structure and each step's selected default skill version, never its most recent one-off run version.
- Clear named owners and recipients, work, skips, completions, outputs, documents, run history, authoring conversations, and source-deal access grants.
- New deals receive fresh step identities and independent project skill identities; subsequent enhancement affects only the destination deal.
- Replacing a template affects future creations only; a creation already admitted keeps its captured revision.
- Preserve Gate 0 validation, conflicts attestation, team creation, notification receipts, and protected rail steps.
- Keep skill package bytes in Ignatious; browsers communicate only with Conductia APIs.
- Use existing dependencies and test frameworks: Conductia Node >=22.12.0, backend Node >=22.13.0 and pnpm 11.17.0.
- Do not enable hosted flags, deploy, merge, or call live models as part of implementation verification.

## Evidence and base

The implementation follows Conductia Parts A through E (#147, #151, #180, #183, #184) and backend Parts B through E (#126, #137, #138, #139), after their integration into `develop` and `main` respectively. Both top PRs were still open at inspection on September 21.

- Conductia inspected tip: `947487e8832b94b6140416129ae8c8a6a8e1792e`. The latest changes expose the actual current project step in deal-list responses and make step-record loading opt-in in `useProjectRail`. Preserve both integrations when adding template creation.
- Backend inspected tip: `caadecd3d81a5d260c696e344d1009458838ee1b`. Changes since `087a374a05fb7ce488e2cadd7d815f2fa28275d5` concern banker questions, tests and the MD briefing skill; the publication and package-copy integration points remain unchanged.
- Requirement: [#168](https://github.com/Conductia/Conductia/issues/168); company/banker defaults are the broader [#117](https://github.com/Conductia/Conductia/issues/117). Automatic permanent edits in [#167](https://github.com/Conductia/Conductia/issues/167) remain separate.
- `src/lib/rail/projectRail.ts` and `deal_steps` already separate structure from runtime work.
- `src/lib/skillRun/step.ts` resolves explicit binding, then custom definition, then catalog mount. Capturing only the definition misses Part E selections.
- `create_deal_gate0` currently writes `origin='catalog'`, compares numeric `seq` for initialization, and allocates the deal UUID internally. Custom steps need fresh UUIDs, nullable sequence, definitions, and an order-based current position.
- Ignatious publications are immutable, carry `project_id`, and currently require a preparation. Copies need an explicit import origin rather than fabricated authoring drafts/preparations.
- Catalog references may use a content hash, while their reconstructed ZIP has a different hash. Preserve source identity and destination package digest separately.
- Conductia's version metadata and duplicate detection currently read publication operations. Imported skills must participate without pretending to have been authored in the destination.

## Snapshot and replacement

`rail_templates` is the stable named company record. `rail_template_revisions` stores immutable manifests and the current revision pointer changes only after all required skill bytes are retained. This is internal revision tracking, not a user-facing version manager.

Name: trimmed, 1–120 characters, case-insensitively unique within the company. Description: optional, at most 500 characters. Replacement retains the chosen template's name and replaces description and content. Renaming and deletion are outside v1. A stale replacement receives 409 and offers reloading the current template or saving under a new name.

The manifest contains catalog keys, custom definitions projected through an allowlist, phases, dense order, and resolved skill references. It never serializes a whole deal row or arbitrary definition JSON. Custom step keys and UUIDs are regenerated on creation. Source anchor UUIDs are discarded; new active steps can use null anchors because their order is explicit and the removal code records a new anchor when needed.

Save captures one coherent database read of steps, bindings and metadata. Catalog fallbacks are resolved once before the immutable revision is admitted. A fingerprint recheck under the source deal lock rejects concurrent structural/binding changes; completed work is deliberately excluded from that fingerprint. Retries resume the admitted manifest, never reread a changed source into the same request.

Completed/skipped active steps return as pending in the destination, except normal Gate 0 initialization. Named assignments are empty. Completed Gate 0 is newly attested and represented using the existing Gate 0 status convention, not copied from the source.

## Skill retention and copying

For each distinct effective skill reference, Ignatious retains the exact package in a company-scoped immutable snapshot asset. A revision with no skill references needs no provider call. Publication assets are checked against their recorded project and company; catalog assets use `readMountPackage`, checking the source reference digest before retaining the ZIP. The archive survives mount pruning or source project access loss.

When used, each distinct asset becomes a new publication identity in the destination project, with an exact ZIP digest. This includes resolved catalog versions, keeping template-created deals independent and reproducible. A catalog step keeps its catalog step key and UI but receives an explicit project binding. Catalog steps with no currently runnable skill remain ordinary catalog steps; normal future catalog availability still applies to them.

Two source steps sharing the same effective reference share one imported identity within the destination. Different source versions are distinct assets. No older versions or drafts are copied. Source-reference provenance remains server-side; the destination's version picker labels its initial version v1 and its author as the importing user.

A new `deal_skill_imports` record holds the copied skill's capability contract and importing actor. Metadata resolution reads ordinary publication operations first and imports second, scoped to the destination deal and exact version. Duplicate comparison, ancestor preview, and author attribution use that resolver. Publication-backed metadata comes from its original operation or prior import; catalog metadata is deterministically derived from the catalog step's description and input/output contract. A missing required publication contract fails save rather than inventing one.

## Creation and recovery

Use request UUIDs for save and template-based creation. Conductia persists admitted commands before provider writes. The provider retains a batch of assets atomically and imports a batch atomically, with request-digest replay checks. No model generation is involved.

A template creation admission freezes the revision, validated Gate 0 payload, reserved destination UUID, and skill/step UUID mapping. Creation from a superseded picker revision is rejected before admission with 409; after admission, replacement is irrelevant. Backend import precedes the final Conductia transaction. That transaction creates the deal, steps, bindings, import metadata, source revision provenance, audit records and the saved response atomically.

Provider timeout or lost response yields a retryable 503 with the request ID; retry the identical command. Browser session storage retains only the pending request ID, not deal or skill content. Actor-scoped command read/resume routes recover after reload. Permission is checked again on resume and finalization. Pending commands are not visible deals/templates. A previously successful request returns its stored receipt without sending another notification or creating another deal. Failed final validation leaves retained provider copies inaccessible; automatic garbage collection is outside v1.

Use ordinary synchronous request attempts and explicit retry/resume. No queue, worker leases, generic saga engine, or polling processor is required for byte copying. Each attempt is bounded by the existing provider timeout.

## UI

- Deal rail action: **Save rail**. Dialog modes **Create new** / **Replace existing**, required name for new, company template selector for replace, optional description, step/skill count preview.
- Sharing text: “Shares step descriptions and selected skill instructions with your company. People, deal work and results are not copied.” This is disclosure within the save action, not a separate approval workflow.
- Replacement text: “Existing projects keep their own copies.”
- Gate 0: **Rail** selector, standard default, named templates and descriptions, ordered step preview. Keep normal new-deal team selection.
- Loading and failure are explicit; a selected template never silently falls back to the standard rail.
- Resume a pending save/create or explicitly start a new command after a terminal conflict. Template controls require `rail_templates`, `project_rail_model`, and `gate0_api_create`; skill-bearing operations also require `skill_authoring`.

## Acceptance

1. Director saves a rail containing removed, skipped, completed, manual and skill steps. Manifest matches active structure and selected defaults; runtime state is absent.
2. Another authorized company user without source-deal access creates a deal from it and can run and enhance the copied skill.
3. Template replacement changes the next creation but not the source or earlier destination. An already admitted creation finishes with its captured revision.
4. Copied skill bytes match the selected source version; a one-off run of another version has no effect. A retained catalog package still copies after mount pruning.
5. Same request replay, concurrent retries, provider response loss and DB finalization failure produce at most one committed template revision/deal and one notification fan-out.
6. Cross-company reads/use/replacement, external users, source access loss during save, and missing create/structure permission are rejected server-side.
7. Baseline creation, protected steps, old publications, run history and standard enhancement remain compatible.

Implementation plan: [2026-09-21-saved-rail-templates.md](../plans/2026-09-21-saved-rail-templates.md).
