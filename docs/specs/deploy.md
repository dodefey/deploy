# Deploy Orchestrator Specification (`src/cli.ts`)

## 1. Purpose

`src/cli.ts` is the deploy orchestrator. It is responsible for:

- Parsing CLI flags.
- Resolving a deploy profile and applying runtime overrides.
- Executing phases in order (tests, build, sync, PM2, churn).
- Enforcing fatal vs non-fatal phase semantics.
- Delegating human-facing logs to `src/deployLogging.ts`.

It does not implement build/sync/PM2/churn internals; those stay in their modules.

---

## 2. Command Surface

Main command: `deploy`

Supported flags:

- `--profile, -p <name>`
- `--sshConnectionString, -s <target>`
- `--remoteDir, -d <path>`
- `--buildDir, -b <path>`
- `--env, -e <name>`
- `--pm2AppName <name>`
- `--pm2RestartMode <startOrReload|reboot>`
- `--skipTests, -T`
- `--dryRun, -n`
- `--skipBuild, -k`
- `--verbose, -V`
- `--churnOnly, -c`
- `--churnDiagnostics <off|compact|full|json>`
- `--churnTopN <positive integer>`
- `--churnReportOut <stdout|path>`

---

## 3. Config and Argument Resolution

### 3.1 Profile selection

- `--profile` is required; no implicit default profile.
- Profile data is resolved via `resolveProfile`.
- Optional runtime overrides are applied via `applyOverrides`.

### 3.2 Deploy context

Resolved values are normalized into `TDeployArgs`, including:

- Connection/build/runtime values.
- Runtime flags.
- Churn diagnostics options (`churnDiagnostics`, `churnTopN`, `churnReportOut`).

### 3.3 Churn defaults

If CLI churn options are not provided:

- `churnDiagnostics` defaults to profile `churn.diagnosticsDefault` (or `off`).
- `churnTopN` defaults to profile `churn.topN` (or `5`).
- `churnReportOut` defaults to undefined.

Invalid churn option values are treated as config-invalid errors (`CONFIG_PROFILE_INVALID`).

---

## 4. Phase Flow

### 4.1 Full deploy mode

Execution order:

1. `runTestPhase`
2. `runBuildPhase`
3. `runSyncPhase`
4. `runPm2Phase`
5. `runChurnPhase`

### 4.2 Churn-only mode

If `--churnOnly` is set:

- Skip test/build/sync/PM2 phases.
- Run `runChurnOnlyMode`.

---

## 5. Phase Behavior

### 5.1 Tests

- Logs phase start.
- Skips when `skipTests` is true.
- Uses `runTests` with `inherit` output mode when verbose, otherwise callback/no-op wiring.
- Failure is fatal.

### 5.2 Build

- Logs phase start.
- Skips when `skipBuild` is true.
- Uses profile-defined `buildCommand`/`buildArgs`.
- Uses `inherit` output mode when verbose, otherwise callback/no-op wiring.
- Failure is fatal.

### 5.3 Sync

- Uses `syncBuild` with resolved paths and `dryRun`.
- Uses `inherit` output mode when verbose, otherwise callback/no-op wiring.
- Failure is fatal.

### 5.4 PM2

- Skips remote update when `dryRun` is true.
- Uses `updatePM2App` otherwise.
- `PM2_APP_NAME_NOT_FOUND` is fatal.
- Other PM2 failures are non-fatal and logged as degraded-success.

### 5.5 Churn (shared logic)

`runChurnAnalysis` uses a single canonical churn path:

- Calls `computeClientChurnReport`.
- Logs churn summary derived from report `core`.
- Emits diagnostics text/json when diagnostics mode is not `off`.
- Writes report JSON when `churnReportOut` is set (`stdout` or file path).

### 5.6 Churn fatality rules

- Full deploy churn failures are non-fatal.
- Churn-only failures are fatal.

---

## 6. Logging Contract

`src/cli.ts` does not emit direct console logs for deploy events. It uses `src/deployLogging.ts` APIs:

- lifecycle logs (`logDeployStart`, `logDeploySuccess`, churn-only equivalents)
- phase logs (`logPhaseStart`, `logPhaseSuccess`)
- PM2 success log (`logPm2Success`)
- churn summary (`logChurnSummary`)
- fatal and non-fatal error logs

---

## 7. Exit Semantics

- Fatal phases (config/tests/build/sync/churn-only) exit with code `1`.
- Non-fatal phases (PM2/churn in full deploy) do not change successful exit code.
- `main()` exits `0` on successful command completion and `1` on unexpected top-level errors.

See `docs/specs/exit-semantics.md` for full rules.

---

## 8. Churn Contract

- Churn always computes canonical report data.
- Summary output always comes from report `core`.
- Diagnostics display remains optional via `churnDiagnostics`.

---

## 9. Related Specs

- `docs/specs/orchestrator-spec.md`
- `docs/specs/logging.md`
- `docs/specs/exit-semantics.md`
- `docs/specs/churn.md`
- `docs/specs/config.md`
