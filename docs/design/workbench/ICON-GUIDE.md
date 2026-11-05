# Icon seed-set guide

This maps product concepts onto glyphs from Lucide, which the repo already depends on via lucide-react. The 27 mapped glyphs are also vendored as standalone SVGs in `icons/lucide/` (used by `Workbench Kit.dc.html`), redistributed under the ISC license kept in `LICENSE-Lucide.txt`. Code imports from lucide-react, not from these files. The set is intentionally brand-neutral and avoids competitor marks.

## Recommended mapping

| Product concept | Suggested icon |
|---|---|
| Universal search | `search.svg` |
| Command palette | `command.svg` |
| Context sidebar | `panel-left.svg` |
| Authorized sources | `database.svg` |
| Document/source | `file-text.svg` |
| Structured analysis | `table-2.svg` |
| Markets/financial trend | `chart-no-axes-combined.svg` |
| Approved/reviewed | `shield-check.svg` or `circle-check-big.svg` |
| Restricted matter | `lock-keyhole.svg` or `folder-lock.svg` |
| Run history | `clock-3.svg` |
| Compare/version diff | `git-compare-arrows.svg` |
| Citation/excerpt | `quote.svg` |
| Exception/risk | `circle-alert.svg` |
| Open source | `external-link.svg` |
| Workflow/agent | `workflow.svg` |
| Institution/bank | `landmark.svg` |
| Deal/work | `briefcase-business.svg` |
| Company/issuer | `building-2.svg` |
| Financial value | `badge-dollar-sign.svg` |
| Legal/compliance | `scale.svg` |
| Extract/review | `scan-text.svg` |
| Policy/playbook | `book-open-check.svg` |
| Review checklist | `list-checks.svg` |
| Evidence search | `search-check.svg` |
| Validated artifact | `file-check.svg` |

## Rendering contract

- Use 16 px for dense navigation/table actions, 18 px for standard controls, and 20 px for prominent empty states or section actions. 14 px is allowed in dense contexts (compact selects, inline meta, chips).
- Use strokeWidth 1.75 throughout; round caps and joins.
- Pair unfamiliar icons with text. Never depend on color or icon alone for status.
- Provide a visible tooltip for icon-only controls and an accessible name in code.
- Use filled icons only for exceptional semantics if the entire set is expanded coherently; do not mix unrelated visual families.
- Do not place icons inside decorative circular tiles by default.
- Mirror directional icons in right-to-left interfaces where their meaning is directional.
- Keep `LICENSE-Lucide.txt` beside the vendored SVGs in `icons/lucide/`, and with any further export of standalone SVG files or the icon library.
