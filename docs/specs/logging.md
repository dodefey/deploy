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
- Modules use:

```ts
outputMode: "callbacks"
onStdoutLine: (line) => {} // no-op
onStderrLine: (line) => {} // no-op
```

---

### 2.2 Verbose mode (`--verbose` = true)

**Behavior:**

- Same phase lines as non-verbose.
- Full build / rsync / PM2 output printed.
- Modules use:

```ts
outputMode: "inherit"
```

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
if (verbose) outputMode = "inherit"
else {
	outputMode = "callbacks"
	onStdoutLine = noop
	onStderrLine = noop
}
```

### Sync

```ts
if (verbose) outputMode = "inherit"
else {
	outputMode = "callbacks"
	onStdoutLine = noop
	onStderrLine = noop
}
```

### PM2

```ts
if (verbose) outputMode = "inherit"
else {
	outputMode = "callbacks"
	onStdoutLine = noop
	onStderrLine = noop
}
```

### Churn

No outputMode; prints summary.

---

## 7. Future-Proofing

- Modules must support `"callbacks"` mode.
- `main.ts` must pass valid callbacks even if no-op.
- Console output must come only from orchestrator (`console.log`) in non-verbose mode.

---

## 8. Non-Goals

- No new deploy flags
- No change to semantics or exit codes
- No churn format changes
- No PM2 behavior changes
- No internal module rewrite beyond outputMode/callback wiring
