# Devin Agent Orchestration State Machine

## Problem

`devin-agent` currently overloads `running` to mean several different realities: actively working, finished a turn and waiting for the parent, blocked, stale, or in the middle of exit cleanup. Parent agents and humans have to infer control flow from terminal output, which makes useful completed turns look hung.

Oracle reviewed the local fixtures and source on 2026-05-28 and recommended a focused Option 1.5: stabilize `devin-agent` first with a local state machine and shared-shaped JSON contract, then port the contract to sibling orchestrators later.

## Non-Negotiable User Requirements

Original request:

> Okay. Lets get all 6 done. Create a master PRD, scope out the work then execute it to completion with $goal please

Required outcomes:

- Master PRD exists and governs the implementation.
- Work is scoped into implementation lanes before edits.
- `$goal` ledger is maintained throughout the run.
- All six Oracle-backed implementation slices are done and validated.

## Solution

Add a durable process/turn model, derive a compact orchestration state for parent agents, expose it through human and JSON CLI output, make `await-turn` state-aware, record prompt/context accounting, parse Devin token usage, and fix the trust/safety defects Oracle identified.

## State Model

### Process State

- `created`
- `starting`
- `running`
- `exiting`
- `exited_success`
- `exited_failure`
- `cancelled`

### Turn State

- `none`
- `starting`
- `working`
- `idle`
- `blocked`
- `failed`

### Blocker Kind

- `auth`
- `onboarding`
- `permission`
- `context_limit`
- `no_active_thread`
- `preflight`
- `tooling`
- `unknown`

### Derived Orchestration State

- `PENDING`
- `STARTING`
- `WORKING`
- `WAITING`
- `BLOCKED`
- `STALE`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

`WAITING` is derived, not stored: `process_state=running`, `turn_state=idle`, and `turns_completed > 0`.

`context_limit` is a `blocked` turn with `blocker_kind=context_limit`, not a peer turn state.

## Implementation Slices

### Slice 1: State Derivation And Terminal Normalization

Owned surface:

- `src/jobs.ts`
- new state helper module if useful

Requirements:

- Add durable process/turn fields without breaking existing job files.
- Derive `orchestration_state` deterministically.
- Normalize terminal jobs so completed/cancelled/failed jobs cannot retain `turnState: "working"`.
- Preserve compatibility with existing `status` where possible.

Acceptance proof:

- Unit tests cover `running + idle -> WAITING`, terminal jobs normalize to idle turns, context-limit becomes blocked, and stale remains non-terminal.

### Slice 2: JSON Output Contract

Owned surface:

- `src/cli.ts`
- `src/jobs.ts`
- state/output helper modules if useful

Requirements:

- Add `status --json <jobId>`.
- Extend `jobs --json` with compact parent-agent fields:
  - `schema_version`
  - `orchestration_state`
  - `process_state`
  - `turn_state`
  - `blocker_kind`
  - `turns_completed`
  - `last_message`
  - `last_activity_at`
  - `usage`
  - `context`
  - `actions`
- Fix `jobs --json --limit N` so it returns exactly `N` jobs unless `--all` is passed.

Acceptance proof:

- Tests or fixture checks show `jobs --json --limit 3` returns exactly 3 and status JSON exposes the derived state fields.

### Slice 3: State-Aware `await-turn`

Owned surface:

- `src/cli.ts`
- `src/jobs.ts` or state helpers

Requirements:

- `await-turn` returns cached `last_message` immediately for `WAITING`.
- `await-turn` returns last message or completion text for `COMPLETED`.
- `await-turn` exits non-zero with clear reason for `BLOCKED`, `FAILED`, `CANCELLED`, and `STALE`.
- Add `await-turn --json`.
- Preserve current behavior of waiting while `WORKING` or `STARTING`.

Acceptance proof:

- Tests or fake-job fixture checks cover `WAITING`, `COMPLETED`, `BLOCKED`, `FAILED`, `CANCELLED`, and `WORKING`.

### Slice 4: Prompt And Context Accounting

Owned surface:

- `src/files.ts`
- `src/jobs.ts`
- `src/cli.ts`
- new prompt/context helper module if useful

Requirements:

- Centralize prompt assembly.
- Store prompt accounting on every real start:
  - `prompt_estimated_tokens`
  - `prompt_bytes`
  - component list
  - map inclusion metadata
  - map actual estimated tokens
  - map metadata `total_tokens` when present
- `--dry-run` reports component-level token/byte estimates.
- Reframe map accounting correctly: Cartographer `total_tokens` is metadata, not injected prompt cost.

Acceptance proof:

- Dry-run and job metadata distinguish actual map estimated tokens from map metadata `total_tokens`.

### Slice 5: Devin Token Usage Parsing

Owned surface:

- `src/atif-parser.ts` or new usage parser helper
- `src/jobs.ts`

Requirements:

- Parse Devin log tails like:
  - `Token usage: total=13,645 input=13,640 (+ 5,504 cached) output=5`
- Store usage in job JSON and expose it through status/jobs JSON.
- Keep existing atif-parser behavior for completed session data.

Acceptance proof:

- Unit test parses the observed fixture string into numeric usage fields.

### Slice 6: Trust And Safety Fixes

Owned surface:

- `src/tmux.ts`
- `src/jobs.ts`
- `src/cli.ts` if needed

Requirements:

- Fix sandbox truthfulness. Either launch Devin with flags matching requested `--sandbox`, or expose `actual_sandbox: "danger-full-access"` when bypass is intentionally used.
- Preferred outcome: honor requested sandbox modes instead of unconditional `--dangerously-bypass-approvals-and-sandbox`.
- Replace destructive job deletion cleanup with archive/trash behavior inside the orchestrator jobs home. Do not remove Devin chat/session/history files under `~/.devin`.

Acceptance proof:

- Launch spec/test proves read-only no longer maps to unconditional bypass.
- Delete/clean tests show job artifacts are archived instead of unlinked.

## CLI Output Contract

### `status <jobId>`

Human output should lead with:

- `State`
- `Process`
- `Turn`
- `Turns completed`
- `Last message`
- `Next`

### `status --json <jobId>`

Must emit:

```json
{
  "schema_version": "devin-agent.job.v1",
  "generated_at": "ISO timestamp",
  "job": {
    "id": "job id",
    "orchestration_state": "WAITING",
    "status": "running",
    "process_state": "running",
    "turn_state": "idle",
    "blocker_kind": null,
    "turns_completed": 1,
    "last_message": "OK",
    "usage": null,
    "context": null,
    "actions": {
      "recommended_next": "send_or_close"
    }
  }
}
```

### `jobs --json`

Must be compact and bounded. It must not include full logs or full prompts.

### `await-turn`

Default stdout remains parent-agent friendly: print only the last message when available. JSON mode emits a stable object.

## Validation Plan

- `bun test`
- Add targeted unit tests for:
  - state derivation
  - JSON contract shape
  - jobs limit
  - await-turn state decisions
  - prompt accounting
  - token usage parsing
  - safe archive/delete behavior
- Run a real or fake smoke where practical:
  - `devin-agent start "Read-only smoke..." -r low -s read-only`
  - `devin-agent await-turn <id>`
  - `devin-agent status --json <id>`

## Scope Boundaries

In scope:

- `devin-agent` source and tests.
- Master PRD and `$goal` ledger.
- Local plugin docs only if CLI help/defaults changed materially.

Out of scope:

- Porting the contract to `cursor-orch` or `claude-agent`.
- Event-sourced runtime.
- HTTP daemon/service.
- Exact tokenizer integration beyond current estimator.
- Deep Claude Code onboarding repair.
