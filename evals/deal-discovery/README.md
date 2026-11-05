# Deal-discovery eval harness

Scores what deal discovery found in a tenant against an answer key that never enters this repository (design Q15, handoff `10-evaluation.md`). It is its own package: the app never imports it (an ESLint fence), and it never imports the app. It reads a file export, so it contacts no database and no Microsoft service.

## Run it

```sh
# 1. Export one tenant's discovery state (read-only, metadata only; from the repo root).
npm run discovery:export -- --tenant <conductia-tenant-uuid> --out /tmp/dd-export

# 2. Check the key, then score. The key must sit outside the repository.
export EVAL_ANSWER_KEY_PATH=/secure/answer-key.json
npm --prefix evals/deal-discovery ci
npm --prefix evals/deal-discovery run check-key
npm --prefix evals/deal-discovery run score -- --export /tmp/dd-export
#   -> evals/out/scorecard-<export timestamp>.md and .html (gitignored, redacted)
# For the full scorecard of a real tenant, write it outside the repository:
npm --prefix evals/deal-discovery run score -- --export /tmp/dd-export --out /secure/scorecards
```

Run the export while the worker is paused (`discovery_worker_enabled` off) or idle: the REST API gives it no read snapshot. `--out` for either command must be outside the repository or under `evals/out/`. "The repository" is every root git names for this checkout: the working tree and, in a linked worktree, the main checkout (`git rev-parse --git-common-dir`). Without git, both commands refuse to run rather than guess.

## Rules

- `EVAL_ANSWER_KEY_PATH` is the only way in, and a path inside the repository is refused after symlinks are resolved.
- No key is committed, not even a synthetic one. The tests write a synthetic mini key to a temp directory at test time.
- The export and the scorecards hold item identifiers and deal names, so they stay out of the repository (`evals/out/` is gitignored).
- A scorecard written inside the repository (`evals/out/`) is always redacted: deal and candidate names, link methods and skip reasons are withheld, and each deal id, Message-ID or document path is shown as a keyed digest (HMAC under a key drawn at random for that scorecard and never printed, so a guessed name or path cannot be confirmed, and two scorecards cannot be joined). `--redact` does the same anywhere. The full scorecard only goes outside the repository.
- Nothing is overwritten: a scorecard, an export or a key that already exists is an error.
- The command prints headline numbers and file paths only.
- The export is validated row by row: a missing or unknown field, a value of the wrong type, a value outside its enum (a candidate state of `archived` or `Proposed`), or a reference to a row the export does not hold is an error. Nothing is filtered out.
- Run it through npm (`run score`, `run check-key`, `run convert`), which builds first. The build stamps `dist/` with a digest of `src/`, and the command refuses to run from a `dist/` built from other sources.

## Building the key from the seeder's ground truth

`ground-truth.json` stays where the seeder wrote it, outside the repository. The converter reads it and writes the key, also outside:

```sh
# Check the file's shape first: keys, types and array lengths, never a value.
npm --prefix evals/deal-discovery run convert -- --ground-truth /secure/ground-truth.json --describe

# Then convert. --coverage is required: complete only if the ground truth lists
# every deal item in the tenant. Add --message-ids <file> when the ground truth
# has no Internet Message-IDs: a map from the seeder's message id to the
# Message-ID the tenant assigned, built on the machine that can reach Graph.
npm --prefix evals/deal-discovery run convert -- --ground-truth /secure/ground-truth.json --out /secure/answer-key.json --coverage complete
EVAL_ANSWER_KEY_PATH=/secure/answer-key.json npm --prefix evals/deal-discovery run check-key
```

Every path is refused inside the repository (`evals/out` included, symlinks resolved), an existing key is never overwritten, and the key is written mode 0600 only after it validates. The input shapes the converter accepts are listed in `src/convertGroundTruth.ts`; when the file differs, it names the keys it found, never their values. It fails closed: a field under two of its spellings, a field or list it does not read (`deals[].emails`, `threads`, a window's `from`/`to`), a value of the wrong type (`dealId: null`, a `window` given as a string, `attachmentOnly: "true"`), and a Message-ID with no `@` (a Graph message id) are all errors, never a silent guess. A file with fields the converter does not know is mapped explicitly from its `--describe` output, not converted by dropping them. A top-level item with no deal reference at all is a negative label, and the converter prints how many there are; an item also listed under a deal keeps its deal and is not counted. `.gitignore` also ignores `answer-key*.json` and `ground-truth*.json` anywhere, as a last guard.

## The answer key, format v1

The format is defined and validated in `src/answerKey.ts`; its header is the reference. In short:

```json
{
  "format": "conductia.deal-discovery.answer-key/v1",
  "itemCoverage": "complete",
  "deals": [
    {
      "id": "T01",
      "name": "Project Falcon",
      "codename": "Falcon",
      "aliases": [],
      "side": "sell",
      "parties": [{ "name": "Heliotrope Inc", "domains": ["heliotrope.example"], "role": "target" }],
      "window": { "start": "2026-01-15", "end": "2026-06-30" }
    }
  ],
  "items": [
    { "kind": "message", "internetMessageId": "<falcon-001@bank.example>", "dealIds": ["T01"] },
    { "kind": "message", "internetMessageId": "<falcon-009@bank.example>", "dealIds": ["T01"], "attachmentOnly": true },
    { "kind": "message", "internetMessageId": "<lunch-006@bank.example>", "dealIds": [] },
    { "kind": "document", "path": "Falcon/CIM v3.pdf", "driveItemId": "01ABCDEF", "dealIds": ["T01"] }
  ]
}
```

- A message is keyed by its Internet Message-ID header, a document by its path inside the library (plus its Graph `driveItemId`, which lets the scorer find a document the worker read but did not store).
- `dealIds: []` marks an item that belongs to no deal.
- `attachmentOnly` marks a message whose deal evidence is only in a mail attachment, which the worker does not read yet.
- `itemCoverage: "complete"` means every deal item in the tenant is listed, so routed items missing from the key count as wrong. `"partial"` leaves them out of precision.
- Unknown fields, duplicate ids or items, and references to missing deals are errors, reported with their JSON path.

## What the scorecard reports

- **Discovery**: precision, recall, fragmentation and merge rate of candidates against deals (`src/match.ts`, `src/assign.ts`).
  - A candidate qualifies for a deal when its dates overlap the deal's window, it names the deal (codename, name, a codename derived from "Project <Name>", or an alias) or shares a party, and at least half of its labeled evidence items belong to the deal. A shared party or a missing date never qualifies a candidate alone.
  - Precision and recall pair candidates and deals one-to-one (a maximum-weight assignment on evidence overlap, then match score), so a duplicate candidate is a false positive. Fragmentation and merge read the many-to-many qualifying relation.
- **Item assignment**: precision and recall over (item, deal) pairs, with every miss in exactly one bucket: never read, read but unrouted (late thread or other), attachment-only, skipped document by reason, routed to another deal, routed but unlinked, or a document the key cannot place.
- **Read, unrouted**: the key's true-deal items the worker read and ledgered unrouted, as a count and a share of true-deal items, with two recall ceilings: if routing were fixed (late thread and other), and if mail attachments were read as well.
- **Post- and pre-rejection, side by side**: post-rejection counts proposed and confirmed candidates and their active links; pre-rejection counts every candidate created and every one of its links. The policy is `CANDIDATE_STATE_POLICY` in `src/tuning.ts`.
- **Week-2 checkpoint**, against the targets in `src/tuning.ts`, all provisional until Storm confirms:
  - discovery precision at least 80% (pre-rejection);
  - discovery recall at least 70% (post-rejection);
  - item precision at least 80% (pre-rejection);
  - item recall at least 50% (post-rejection);
  - fragmentation rate at most 25% (pre-rejection);
  - merge rate at most 20% (pre-rejection).

  Everything a rejection or a merge could improve is taken pre-rejection, so no correction, by a person or automatically, can move the verdict. Discovery and item recall are post-rejection, since a rejection can only lower them. An n/a (0/0) item precision, item recall, fragmentation or merge rate is a fail. Every target met means a discovery-led demo; any missed means a seeded one. A partial key gives no verdict (undetermined): the items it does not list are invisible to the evidence gate and to item precision.

  From phase 8 on, the eval scores the model's output before any correction (the input to `foldCorrections`), so no correction can move any metric.
- **Provenance**: the harness commit (flagged when `evals/deal-discovery` has uncommitted changes) and a digest of the tuning constants. A score made without provenance (a direct `score()` call) says so in a warning.
- **Five worst errors**, each with the evidence ids behind it, plus ingestion counts and the links by method and route tier.

## Tuning

Every weight and threshold the scorer decides with (the matching window, weights and evidence gate, the merge rule, the candidate-state policy and the checkpoint targets) is in `src/tuning.ts`. Nothing else holds a literal.

The file is frozen: `test/tuning.test.ts` pins every value and the digest the scorecard prints. Change a value only as a reviewed diff, swept on synthetic data, never after reading a real-tenant scorecard, and update the pinned values and digest in the same diff.

## Tests

```sh
npm --prefix evals/deal-discovery test
```

The package compiles with its own `typescript` into `dist/` and runs on `node:test`. It has no runtime dependency. `test/degenerate.test.ts` re-runs both phase 5 reviews' tables of degenerate systems and prints each row's verdict: only the perfect system may be discovery-led, each other row states exactly which checks it fails, and the rows with unknown candidate states must be refused by the export reader.
