# Project 2: Output / Logging Consistency for main.ts and Modules

## 1. Purpose

Provide a consistent, readable, intentional logging experience across the whole deploy flow while keeping terminal fidelity and deploy-file logging intentionally separate.

This project introduces:

- A unified deploy “story” shown to the user.
- Clean, predictable logs in **non-verbose** mode.
- Detailed, tool-native logs in **verbose** mode.
- A structured deploy record in file logging mode.

This spec **does not** change deploy semantics, exit codes, or module behavior.

---

## 2. Verbose vs Non-Verbose Behavior

### 2.1 Non-verbose mode (`--verbose` = false)

**Goals:**

- Clean, minimal output.
- Easy to read in CI or terminal.
- No raw process output in the terminal.
- Consistent start/finish markers for each phase.

**Behavior:**

- Always print for each phase:
    - `[deploy] <Phase>...`
    - `[deploy] <Phase> completed successfully.`
- Always print:
    - Deploy start line
    - Deploy finish line
    - Churn summary
    - Churn-only start/complete lines when running churn-only
- No direct process output.
- If profile file logging is enabled, the deploy log records phase lifecycle lines, command metadata, typed errors, and phase results.
- Quiet mode may also capture raw child output into the deploy log because it does not distort the human terminal stream.
- Modules use:

```ts
outputMode: "callbacks"
onStdoutChunk: (chunk) => { /* optional quiet-mode file capture only */ }
onStderrChunk: (chunk) => { /* optional quiet-mode file capture only */ }
```

---

### 2.2 Verbose mode (`--verbose` = true)

**Behavior:**

- Same phase lines as non-verbose.
- Full test / build / rsync / PM2 output printed.
- Verbose mode must preserve direct command behavior for surfaced commands by letting those commands talk to the terminal through inherited stdio.
- For tests, "full output" means the complete terminal-visible Vitest stream, not just final reporter summaries.
  This includes live in-place progress/status output such as:
    - incremental `Test Files` / `Tests` counters
    - per-file running/progress lines like `❯ ... 0/7`
    - queued/running transitions
    - startup lines such as `RUN ...` and other TTY-visible status output
- In verbose mode, test output must therefore preserve terminal behavior closely enough that a user sees the same substantive stream they would see from running `npx vitest run` directly in that terminal.
- The same fidelity requirement applies to build, sync, and PM2 output for the commands intentionally surfaced to the operator.
- Modules use:

```ts
outputMode: "inherit"
```

Profile default:

- If `--verbose` is not passed, verbose mode may still be enabled by
  `logging.console.verboseDefault` in the selected profile.

---

## 3. Phase Logging Requirements

Every phase logs:

1. `[deploy] <Phase>...`
2. `[deploy] <Phase> completed successfully.`

### 3.1 Build

- `[deploy] Running build...`
- `[deploy] Build completed successfully.`

### 3.2 Sync

- `[deploy] Syncing client bundle to server...`
- `[deploy] Client bundle sync complete.`

### 3.3 PM2

- `[deploy] Updating PM2 app "<name>"...`
- `[deploy] PM2 update complete: <instanceCount> instances online (mode: <restartMode>).`

### 3.4 Churn (full deploy)

- `[deploy] Computing client churn metrics...`
- `[deploy] Client churn analysis complete.`

### 3.5 Churn-only mode

- `[deploy] Starting churn-only run for profile "<name>"...`
- `[deploy] Computing client churn metrics...`
- (summary printed)
- `[deploy] Client churn analysis complete.`
- `[deploy] Churn-only run completed successfully for profile "<name>".`

---

## 4. Deploy-Level Logging

Always printed:

### Start:

```
[deploy] Starting deploy for profile "<name>"...
```

### End (full deploy):

```
[deploy] Deploy completed successfully for profile "<name>".
```

### End (churn-only):

```
[deploy] Churn-only run completed successfully for profile "<name>".
```

Notes:

- The deploy start/end lines apply to a full deploy only. In churn-only mode, use the churn-only start/end lines instead (see 3.5); do not print the normal deploy start/end lines.

---

## 5. Error Logging Format

### 5.1 Fatal errors

Used for config, build, sync, churn-only.

Format (when profile is known):

```
<Label> error [<CODE>] (profile="<PROFILE_NAME>"): <message>
```

If no profile name is available (rare), the logger may omit `(profile="...")` and use the simpler formats (e.g., `<Label> error [<CODE>]: <message>`).

### 5.2 Non-fatal errors

Used for PM2 and full-deploy churn errors.

Format (when profile is known):

```
Deploy succeeded, but <Label> step failed [<CODE>] (profile="<PROFILE_NAME>"): <message>
```

If no profile name is available (rare), the logger may omit `(profile="...")` and use the simpler formats (e.g., `Deploy succeeded, but <Label> step failed [<CODE>]: <message>`).

---

## 6. Module Invocation Semantics

### Build

```ts
if (verbose) {
	outputMode = "inherit" // human channel
} else if (fileLoggingEnabled) {
	outputMode = "callbacks" // optional quiet-mode capture
} else {
	outputMode = "silent"
}
```

### Sync

```ts
if (verbose) {
	outputMode = "inherit" // rsync / surfaced ssh commands talk directly to terminal
} else if (fileLoggingEnabled) {
	outputMode = "callbacks"
} else {
	outputMode = "silent"
}
```

### PM2

```ts
if (verbose) {
	outputMode = "inherit" // surfaced PM2 restart commands talk directly to terminal
} else if (fileLoggingEnabled) {
	outputMode = "callbacks"
} else {
	outputMode = "silent"
}
```

### Tests

```ts
if (verbose) {
	outputMode = "inherit"
} else if (fileLoggingEnabled) {
	outputMode = "callbacks"
} else {
	outputMode = "silent"
}
```

Requirements:

- In verbose mode, terminal output for tests must be driven by direct child terminal execution, not by callback teeing.
- Specifically, verbose test output must include the live Vitest progress and status stream that appears in direct terminal execution, not merely the post-run reporter summary or incidental application console output.
- Deploy-mode tests must be invoked with a reporter setup that preserves live terminal output while also producing a machine-readable test record for the deploy log.
- If profile file logging is enabled, the test portion of the run log must show:
    - which tests were run
    - which tests passed
    - which tests failed, if any
    - failed test names and assertion details
- These test details must be present in the log even when the deploy exits fatally after the test phase.

### Churn

No outputMode; prints summary.

---

## 7. Future-Proofing

- Modules must support `"callbacks"` mode.
- Verbose orchestration for tests/build/sync/PM2 must preserve direct terminal behavior by using inherited stdio for surfaced commands.
- Build/sync/PM2/tests must support raw chunk forwarding in callback mode; line callbacks remain available as a compatibility fallback.
- `main.ts` must pass valid callbacks even if no-op.
- Console output must come only from deploy logging or direct child execution, not callback-based terminal reconstruction.
- When profile file logging is enabled, the deploy log is a separate deploy record. It must contain enough information to reconstruct what ran, what happened, and why it passed or failed.
- For verbose terminal output, fidelity to direct command execution is required, not approximate formatting or transcript replay.

---

## 8. Non-Goals

- No new deploy flags
- No change to semantics or exit codes
- No churn format changes
- No PM2 behavior changes
- No internal module rewrite beyond outputMode/callback wiring
