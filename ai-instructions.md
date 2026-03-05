# Shared AI Instructions for `@dodefey/deploy`

Goal: keep deploy behavior stable while making safe, consistent changes.

## Instruction Precedence

- User-scoped baseline instructions: `~/.codex/AGENTS.md`.
- Repository-local instructions in this file override user-scoped instructions when they conflict.

## Agent-Critical Constraints

- Keep typed error code behavior stable (`Error.cause` contracts).
- Keep fatal vs non-fatal phase semantics stable:
    - Fatal: config, tests, build, sync, churn-only.
    - Non-fatal in full deploy: PM2 and churn.
- Use `src/deployLogging.ts` for human-facing logs; avoid new direct module-level console logging.
- Keep remote churn manifests under `.deploy/` (outside rsync delete scope).
- Preserve default churn summary compatibility unless changes are explicitly intended.

## Where Canonical Specs Live

- Full behavior and module contracts are canonical in `docs/specs/*`.
- Start with:
    - `docs/specs/orchestrator-spec.md`
    - `docs/specs/exit-semantics.md`
    - `docs/specs/logging.md`
    - `docs/specs/error-taxonomy-and-documentation.md`
    - `docs/specs/churn.md` and `docs/specs/churn-format.md`

## Output Handling Pattern

- Shared outputMode contract across build/sync/PM2/tests:
    - `inherit`: stream child output.
    - `silent`: ignore child output.
    - `callbacks`: split by line and invoke handlers.

## Change Discipline

- If you change behavior/semantics, update `docs/specs/*` and `README.md` in the same change.
- If you add flags or error codes, thread them through CLI, logging, tests, and docs consistently.
