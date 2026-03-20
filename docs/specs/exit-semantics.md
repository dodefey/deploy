# Project 3: Exit Semantics and Return Paths

## 1. Purpose

The goal of Project 3 is to make the CLI exit behavior explicit, predictable, and easy to reason about, while keeping the deploy script focused on deployment logic rather than process control.

We want:

- Clear rules for which phases are **fatal** vs **non-fatal**.
- A minimal number of direct process termination calls.
- `main.ts` to behave cleanly in both success and failure cases while still letting pending output and log writes flush.

This spec assumes the existing phase structure:

- Configuration (profile selection, config resolution, overrides)
- Build
- Sync
- PM2
- Churn (full deploy)
- Churn-only mode

---

## 2. Definitions

**Fatal phase**

- A failure in this phase must cause the process to exit with code `1`.

**Non-fatal phase**

- A failure in this phase should be logged, but must **not** change the exit code from `0` if everything fatal succeeded.

---

## 3. Fatal vs Non-fatal Rules

### Fatal phases

These phases are considered fatal:

- Configuration (profile selection, config resolution, overrides)
- Build (profile-defined build)
- Sync (client bundle rsync to server)
- Churn-only (when running `churnOnly` mode)

### Non-fatal phases

These phases are non-fatal:

- PM2 update (reload / reboot of the app)
- Churn after a successful deploy (full deploy mode)

### Exit code summary

- If **any fatal phase** fails: exit code **1**.
- If **only non-fatal phases** fail: exit code **0**.
- If **everything succeeds**: exit code **0**.

Any `CONFIG_*` error raised during profile normalization or resolution (including `CONFIG_PROFILE_FILE_NOT_FOUND` for missing/unreadable/invalid/empty `profiles.json`) is fatal, logged via `logFatalError`, and results in exit code `1`.

---

## 4. Exit Code Placement Rules

We will use the following rules for where exit codes are assigned.

### 4.1 Fatal exit helper

There is exactly one helper responsible for structured fatal handling:

```ts
function handleFatalError(label: string, err: unknown): never
```

`handleFatalError` must:

- Log an error in the existing format:
    - `"<Label> error [CODE]: message"` or
    - `"<Label> error: message"`

- Throw a fatal sentinel error after logging.
- Never return (`never` type).

Only **fatal phases** are allowed to call `handleFatalError`:

- Configuration helpers (`selectConfig`, `applyOverrides`) may throw typed errors; `deployCommand.run` must catch those and call `handleFatalError("Configuration", err)`.
- The orchestrator (not the helpers) calls `handleFatalError` for these fatal phases:
    - Configuration selection / overrides (“Configuration” errors)
    - Build phase (“Build” errors)
    - Sync phase (“Build sync” errors)
    - Churn-only mode (“Client churn” errors in churn-only mode)

### 4.2 Success exit codes

- The deploy command body (`deployCommand.run`) must **not** call `process.exit` directly for success.
- On both full-deploy success and churn-only success, `deployCommand.run` must simply **return** (resolve) normally.

There is exactly **one** success exit assignment, at the bottom-level wrapper around `cli`:

- After `cli` resolves without throwing, we set `process.exitCode = 0`.

### 4.3 Last-resort exit (unexpected errors)

The top-level wrapper will catch any fatal or unexpected errors that escape `cli` and will:

- Set `process.exitCode = 1`.
- Log a generic error only for unexpected errors. Fatal errors already logged by `handleFatalError` must not be logged twice.

This last-resort catch does **not** replace `handleFatalError`. It only handles errors that were **not** handled by the orchestrator logic (for example, programmer errors or unexpected throws in libraries).

---

## 5. Top-level Structure

### Current

`main.ts` uses a top-level `main()` wrapper:

```ts
async function main(): Promise<void> {
	try {
		await cli(process.argv.slice(2), deployCommand)
		process.exitCode = 0
	} catch (err) {
		console.error("Unexpected deploy error:", err)
		process.exitCode = 1
	}
}

void main()
```

### Required structure

Wrap `cli` in a small async `main` function (or an immediately invoked async function) that enforces the exit policy:

```ts
async function main(): Promise<void> {
	try {
		await cli(process.argv.slice(2), deployCommand)
		// If we get here, run() resolved without any fatal error.
		process.exitCode = 0
	} catch (err) {
		// Last-resort: fatal or unexpected error that escaped the orchestrator.
		console.error("Unexpected deploy error:", err)
		process.exitCode = 1
	}
}

void main()
```

Notes:

- `handleFatalError` throws after logging so phase-local cleanup and `finally` blocks can still run.
- `main()` still reaches its `catch` block for fatal errors, but it must recognize them as already logged and avoid duplicating the message.

---

## 6. Changes Required in `deployCommand.run`

### 6.1 Remove success exits

Remove `process.exit(0)` from the following places:

- After `runChurnOnlyMode(deploy)`
- After the full deploy phase sequence (`runBuildPhase`, `runSyncPhase`, `runPm2Phase`, `runChurnPhase`)

After completing:

- **Churn-only** mode, or
- **Full deploy** mode,

`deployCommand.run` must simply return (resolve) and let the top-level `main()` decide the final exit code.

### 6.2 Keep fatal exits via `handleFatalError`

All current calls to `handleFatalError` inside:

- Configuration selection
- Build phase
- Sync phase
- Churn-only mode

remain and are still allowed to throw the logged fatal sentinel.

---

## 7. Phase-level Behavior Requirements

For each phase helper (`runBuildPhase`, `runSyncPhase`, `runPm2Phase`, `runChurnPhase`, `runChurnOnlyMode`):

### 7.1 No direct process termination

Phase helpers must **not** call `process.exit` directly.

### 7.2 Fatal phases

If an error occurs in a fatal phase:

- Call `handleFatalError("<Label>", err)`.
- Let the fatal sentinel propagate so outer cleanup can complete.

### 7.3 Non-fatal phases

For PM2 and churn (in full deploy mode):

- Catch errors.
- Log them via `logNonFatalError("<Label>", err)`.
- Return normally so the deploy can continue and end with exit code `0` if no fatal failures occurred.

### 7.4 Churn-only

- On success:
    - Log the churn-only start and completion lines as already specified in the logging spec.
    - Return normally.
- On failure:
    - Use `handleFatalError("Client churn", err)`.

---

## 8. Error Type and `cause` Behavior

`handleFatalError` and `logNonFatalError` must preserve the current behavior:

- Extract `err.cause` when it is a string.
- If a cause code exists:
    - Fatal: `"<Label> error [CODE]: message"`
    - Non-fatal: `"Deploy succeeded, but <Label> step failed [CODE]: message"`

- If no cause:
    - Fatal: `"<Label> error: message"`
    - Non-fatal: `"Deploy succeeded, but <Label> step failed: message"`

No new exit helper functions are allowed besides:

- `handleFatalError`
- The top-level `main()` `try/catch` that sets `process.exitCode`.

---

## 9. Summary of Allowed Exit Paths

**Allowed exit code `1` paths:**

- Via `handleFatalError`, called from:
    - `deployCommand.run` when handling configuration failures from `selectConfig` / `applyOverrides`
    - `runBuildPhase` (Build failures)
    - `runSyncPhase` (Sync failures)
    - `runChurnOnlyMode` (Client churn failures in churn-only mode)

- Inside `main()`’s `catch` for fatal or unexpected errors not handled by the above.

**Allowed exit code `0` path:**

- Inside `main()`, after `cli(...)` resolves without throwing.

**Disallowed:**

- Any new direct calls to `process.exit` in phase helpers or in `deployCommand.run`.

---

## 10. Documentation Requirement

At the top of `main.ts`, add a short comment summarizing exit semantics. For example:

```ts
// Exit semantics:
// - Fatal phases: configuration, build, sync, churn-only.
//   Failures exit with code 1 via handleFatalError.
// - Non-fatal phases: PM2 and churn (full deploy).
//   Failures are logged but do not change exit code (still 0 on success).
// - Top-level main() sets process.exitCode after command completion so
//   pending output can flush.
```

This comment must stay in sync with the actual behavior if exit semantics change in the future.
