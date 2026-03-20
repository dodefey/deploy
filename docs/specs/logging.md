# Project 2: Output / Logging Consistency for main.ts and Modules

## 1. Purpose

Provide a consistent, readable, intentional logging experience across the whole deploy flow—build → sync → PM2 → churn—while keeping verbosity under explicit user control.

This project introduces:

- A unified deploy “story” shown to the user.
- Clean, predictable logs in **non-verbose** mode.
- Detailed, tool-native logs in **verbose** mode.
- Future-proof structure for progress bars, warnings, file logs, etc.

This spec **does not** change deploy semantics, exit codes, or module behavior.

---

## 2. Verbose vs Non-Verbose Behavior

### 2.1 Non-verbose mode (`--verbose` = false)

**Goals:**

- Clean, minimal output.
- Easy to read in CI or terminal.
- No raw process output.
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
- If profile file logging is enabled, the deploy log still captures full child output from tests, build, sync, and PM2.
- Modules use:

```ts
outputMode: "callbacks"
onStdoutChunk: (chunk) => { /* write to log file only, or noop if disabled */ }
onStderrChunk: (chunk) => { /* write to log file only, or noop if disabled */ }
```

---

### 2.2 Verbose mode (`--verbose` = true)

**Behavior:**

- Same phase lines as non-verbose.
- Full test / build / rsync / PM2 output printed.
- Verbose mode must use an interactive/PTY-backed transport for external commands whose direct terminal behavior depends on seeing a TTY.
- For tests, "full output" means the complete terminal-visible Vitest stream, not just final reporter summaries.
  This includes live in-place progress/status output such as:
    - incremental `Test Files` / `Tests` counters
    - per-file running/progress lines like `❯ ... 0/7`
    - queued/running transitions
    - startup lines such as `RUN ...` and other TTY-visible status output
- In verbose mode, test output must therefore preserve TTY-style behavior closely enough that a user sees the same substantive stream they would see from running `npx vitest run` directly in that terminal.
- The same fidelity requirement applies to build, sync, and PM2 output: verbose deploy mode must surface the same substantive terminal stream the operator would see from running the underlying command directly.
- Modules use:

```ts
outputMode: "callbacks"
onStdoutChunk: (chunk) => { /* tee to terminal, optional file */ }
onStderrChunk: (chunk) => { /* tee to terminal, optional file */ }
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
outputMode = "callbacks"
if (verbose) {
	runViaInteractiveTransportAndTeeToTerminalAndLog()
} else {
	onStdoutChunk = writeRawChunkToLogOrNoop
	onStderrChunk = writeRawChunkToLogOrNoop
}
```

### Sync

```ts
outputMode = "callbacks"
if (verbose) {
	runViaInteractiveTransportAndTeeToTerminalAndLog()
} else {
	onStdoutChunk = writeRawChunkToLogOrNoop
	onStderrChunk = writeRawChunkToLogOrNoop
}
```

### PM2

```ts
outputMode = "callbacks"
if (verbose) {
	runViaInteractiveTransportAndTeeToTerminalAndLog()
} else {
	onStdoutChunk = writeRawChunkToLogOrNoop
	onStderrChunk = writeRawChunkToLogOrNoop
}
```

### Tests

```ts
outputMode = "callbacks"
if (verbose) {
	runViaInteractiveTransportAndTeeToTerminalAndLog()
} else {
	onStdoutChunk = writeRawChunkToLogOrNoop
	onStderrChunk = writeRawChunkToLogOrNoop
}
```

Requirements:

- In verbose mode, terminal output for tests must be byte-for-byte equivalent to running the underlying test command directly in the same terminal.
- Specifically, verbose test output must include the live Vitest progress and status stream that appears in direct terminal execution, not merely the post-run reporter summary or incidental application console output.
- Deploy-mode tests must be invoked with a reporter that emits individual test names and outcomes.
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
- Verbose orchestration for tests/build/sync/PM2 must support an interactive/PTY-backed execution path.
- Build/sync/PM2/tests must support raw chunk forwarding in callback mode; line callbacks remain available as a compatibility fallback.
- `main.ts` must pass valid callbacks even if no-op.
- Console output must come only from orchestrator-managed forwarding in non-verbose mode.
- When profile file logging is enabled, deploy logs and all child output from tests, build, sync, and PM2 are also written to the configured log file.
- For verbose terminal output, fidelity to direct command execution is required, not approximate formatting.

---

## 8. Non-Goals

- No new deploy flags
- No change to semantics or exit codes
- No churn format changes
- No PM2 behavior changes
- No internal module rewrite beyond outputMode/callback wiring
