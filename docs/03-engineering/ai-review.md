# AI review

An AI reviewer reads every pull request into `develop`. Today it is advisory. The goal is that a green `ai-review` check is enough to merge outside a human fence, once a scored trial shows it is reliable. Design: [AI reviewer design doc](https://claude.ai/code/artifact/625af5ed-37ac-46ef-bac0-755e92aa2e69). Decision: D88 in the [decision log](../07-decisions/decision-log.md). It ships with PRs #513, #514 and the scoring PR.

## Layout

| Role | What it does |
|---|---|
| Generalist | Reads the whole diff for correctness, edge cases and regressions traced through callers. Always runs. |
| Governance lens | Authorization on every path, tenant scope, audit records, approval bypass, model gates and egress. |
| Tests and agentic lens | Tests that would pass without the change, mocks that hide behavior, content that can steer an agent, unvalidated model output, unbounded spend. |
| Validator | Confirms or rejects each finding with file and line evidence. It does not know which reviewer raised a finding, and sees findings in shuffled order. |
| Evaluator | Deduplicates and ranks severity. |
| Decision | Plain code. A confirmed blocking finding fails the check and adds `needs-human`. Anything else passes. |

Why this shape. A generalist with lenses beat specialists alone: specialists without a correctness generalist collapse (arXiv 2511.16708). Reviewers from one model family share most of their errors, about 60% of joint errors are the same answer (arXiv 2506.07962), so verification should come from another family where possible. Every production reviewer (Claude Code Review, Kilo, Qodo, Bugbot) verifies a finding against the code before posting it. Our own history agrees: a generalist plus lenses, each validated by the other, produced the most unique majors with the fewest false findings.

## Routing

Router: `scripts/ai-review/router.ts`, config in `.github/ai-review/profiles.json`.

- The generalist always runs.
- Labels `governance` or `security` force the governance lens. Labels `agentic` or `tests` force the tests and agentic lens.
- Matching paths add a lens without a label.

Strictness is set automatically:

- Light: under 50 changed lines and no fenced path. Generalist only, no evaluator.
- Standard: lenses by path and label.
- Strict: any fenced path, including a rename's old path. All three lenses and the evaluator.

## The fence

`.github/ai-review/fence.json` lists the paths that need a human: every specific path in `.github/CODEOWNERS` (a test keeps them in step), plus the areas below. The `develop` ruleset's Required reviewers rule adopts the same list when the gate turns on. Inside the fence the bot labels `needs-human` and never decides alone. Areas:

- Database migrations and the API access layer (`supabase/migrations/**`, `src/lib/api/v1/access.ts`).
- Authentication and middleware (`src/lib/auth/**`, `src/middleware.ts`).
- Model gates and policy (`src/lib/modelGateway/processorGate.ts`, `src/lib/ai/modelPolicy.ts`, `src/lib/ai/processorRules.ts`).
- Mailbox and reader access (`src/lib/mailboxAccess/**`, Graph and Google readers, discovery source).
- Compliance (`src/lib/compliance/**`).
- Fence tests and lint config (`eslint.config.mjs`, `tests/*fence*.test.ts`, `tests/agent-surfaces.test.ts`).
- Infrastructure IAM and deploy roles.
- Workflows, CODEOWNERS, the reviewer itself, and agent instructions (`.github/workflows/**`, `.github/ai-review/**`, `CLAUDE.md`, `AGENTS.md`, `.claude/**`).

## Security model

- `pull_request_target` runs the workflow and scripts from `develop`. A PR cannot change its own reviewer.
- Both checkouts use `persist-credentials: false`, so no GitHub token is stored on disk.
- The PR head is checked out as files only. Nothing in it is installed, built or executed.
- The script computes the diff and hands it to the reviewers as untrusted text. Reviewers have no shell. They get only Read and Glob, limited to the checkout, in a mode that refuses anything else.
- In CI each reviewer runs with a fresh empty home directory and an environment without the GitHub token.
- Before anything is posted or uploaded, the output is checked for live tokens, their base64 forms and token-shaped strings. On a hit nothing is posted. The check fails closed in gate mode and is neutral in advisory mode.
- Every prompt loses invisible characters (Unicode format characters such as zero-width and bidirectional controls, and variation selectors) before it reaches a model.
- Before any model call, a tripwire scans the added lines for those characters and for text addressed to an AI reviewer ("ignore previous instructions", "note to the AI reviewer", "approve this PR", "report no findings"). A hit makes the review incomplete: neutral in advisory mode, failure in gate mode, with `needs-human` and the exact `file:line` listed so a person reads those lines. It is a second line of defence, not a filter: the fence keeps humans on the paths where a successful injection would matter most.
- The evaluator can merge, lower or drop validated findings. It can never add a finding or raise its severity, and it can never drop or lower a confirmed blocking finding.
- Reviews post as comments, never approvals.
- A comment trigger runs only for members and collaborators, only on PRs into `develop`, and always with `develop`'s reviewer. The comment text reaches the script through an environment variable.

## Models

- Trial: Claude only, on a personal subscription token, while company accounts roll out. The validator is a fresh Claude context, not another family. This limitation closes at production.
- Production: an API key through the Vercel AI Gateway with zero data retention. Codex is the generalist and cross-validates Claude findings. A third family is the evaluator.
- Models per phase: `.github/ai-review/models.json`.

## Using it

- Read the `ai-review` check and the inline comments on the PR.
- Add a label (`governance`, `security`, `agentic`, `tests`) to force a lens. The check re-runs.
- Comment `@ai-reviewer` on a PR to run a review. A member or collaborator can do this. Text after it (for example `@ai-reviewer: check for integration issues`) is passed to every reviewer as a focus. The words `security`, `governance`, `tests` or `agentic` force that lens.
- The comment trigger works once the workflow is on `main`, because GitHub runs comment-triggered workflows from the default branch.
- The bot reacts when it starts and replies with one line when it ends.
- Replay a PR: run the *AI review* workflow with `workflow_dispatch` and the PR number.
- `needs-human` means a person must review before merge.
- A neutral check means a reviewer failed or output was withheld. Re-run to retry.

## Setup

Run `claude setup-token` and store the result as the repository secret `CLAUDE_CODE_OAUTH_TOKEN`. The repository secret `ANTHROPIC_API_KEY` is the fallback, used only when the OAuth token is not set. Without either, the check reports neutral and nothing runs.

## Rollout

| Phase | Gate to leave it |
|---|---|
| 1. Build (#513, #514, scoring) | Merged, replay on PRs with known human findings. |
| 2. Advisory trial, two weeks | Weekly score (`ai-review-score` workflow): precision proxy, misses proxy, latency per lens, reviewed by the team. |
| 3. Move to the gateway | ZDR confirmed, Codex and the third family wired, trial repeated on the new models. |
| 4. Gate on | The `develop` ruleset drops to 0 required approvals, requires the `ai-review` check, and adds the path-based Required reviewers rule for a reviewers team on the fence paths. |

In gate mode (`.github/ai-review/gate.json`), a review that did not finish reports failure, because GitHub counts a neutral check as passing.

## Reversal

One ruleset change: restore the required approval count and drop the `ai-review` requirement. The reviewer keeps running as advisory.

## Code

- `scripts/ai-review/`: `router.ts`, `decide.ts`, `findings.ts`, `pipeline.ts`, `run.ts`, `score.ts`, `score-run.ts`.
- `.github/ai-review/`: `profiles.json`, `fence.json`, `models.json`, `prompts/`.
- `.github/workflows/ai-review.yml`, `.github/workflows/ai-review-score.yml`.
- `tests/ai-review/`.
