# Project: Orchestrator spec for `src/cli.ts` (thin conductor)

## High-level goal

Keep `src/cli.ts` a **high-level deploy story** so that:

- It reads as a **high-level deploy story** (tests → build → sync → pm2 → churn).
- All detailed work is delegated to:
    - existing modules (`build`, `syncBuild`, `pm2`, `churn`)
	- a few small, well-named helpers in `src/cli.ts`.
- Error handling is **centralized and consistent**.
- There are **no behavioral changes** to deploy logic (same flags, same semantics, same exit behavior), only code organization and clarity improvements.

---

## 1. Introduce a single deploy context type

### 1.1 Define `TDeployArgs` in `src/cli.ts`

Add a top-level interface in `src/cli.ts`:

```ts
interface TDeployArgs {
	sshConnectionString: string
	remoteDir: string
	buildDir: string
	buildCommand: string
	buildArgs: string[]
	env: string
	pm2AppName: string
	pm2RestartMode: "startOrReload" | "reboot"
	dryRun: boolean
	skipTests: boolean
	skipBuild: boolean
	verbose: boolean
	churnOnly: boolean
	profileName: string
}
```

This type represents the **resolved, fully-validated deploy configuration for a single run**, including:

- Environment / profile info (sshConnectionString, remoteDir, env, pm2AppName, pm2RestartMode, profileName)
- Runtime flags (dryRun, skipTests, skipBuild, verbose, churnOnly)
- Local build dir (buildDir)

### 1.2 Build exactly one `TDeployArgs` in `run()`

After:

- CLI args are parsed (`ctx.values`),
- Config profile is selected via `config.ts`,
- Overrides are applied,

construct a single object:

```ts
const deploy: TDeployArgs = {
	sshConnectionString: merged.sshConnectionString,
	remoteDir: merged.remoteDir,
	buildDir: merged.buildDir,
	env: merged.env,
	pm2AppName: merged.pm2AppName,
	pm2RestartMode: merged.pm2RestartMode,
	dryRun: values.dryRun,
	skipTests: values.skipTests,
	skipBuild: values.skipBuild,
	verbose: values.verbose,
	churnOnly: values.churnOnly,
	profileName: merged.name,
}
```

Use this `deploy` object for all subsequent calls in `src/cli.ts`.

---

## 2. Normalize phases into helpers

### 2.1 Refactor helper signatures to use `TDeployArgs`

Helpers should accept `TDeployArgs` instead of ad-hoc shapes (e.g. `runTestPhase`, `runBuildPhase`, `runSyncPhase`, `runPm2Phase`, `runChurnPhase`, `runChurnOnlyMode`). Inside each helper, destructure only what is needed and keep the module calls (`runTests`, `runBuild`, `syncBuild`, `updatePM2App`, `computeClientChurn`) unchanged aside from mapping fields.

### 2.2 Add explicit phase helpers

Ensure the following helpers exist in `src/cli.ts`:

```ts
async function runBuildPhase(values: TDeployArgs): Promise<void> { ... }
async function runTestPhase(values: TDeployArgs): Promise<void> { ... }
async function runSyncPhase(values: TDeployArgs): Promise<void> { ... }
async function runPm2Phase(values: TDeployArgs): Promise<void> { ... }
async function runChurnPhase(values: TDeployArgs): Promise<void> { ... }
async function runChurnOnlyMode(values: TDeployArgs): Promise<void> { ... }
```

**Behavior:**

- `runTestPhase`
	- If `values.skipTests` is true, log the skip message and return.
	- Otherwise, call the test module (`runTests`) with the existing outputMode wiring.
	- On error, treat as fatal.

- `runBuildPhase`
	- If `values.skipBuild` is true, log the same “Skipping build” message as today and return.
	- Otherwise, call the build module (`runBuild`) with the profile-provided `buildCommand`/`buildArgs` and the same outputMode wiring as before.
    - On error, delegate to the new fatal error helper (see section 3).

- `runSyncPhase`
    - Call `runSyncBuild(values)` (or inline the thin wrapper) which calls `syncBuild` with the same options as before.
    - On error, use the new fatal error helper.

- `runPm2Phase`
    - Call `handlePm2(values)` (which wraps `updatePM2App`) with the same options as before.
    - On error, treat as **non-fatal**, via the new non-fatal error helper.

- `runChurnPhase` (full deploy mode)
    - Call `handleChurn(values)` (which wraps `computeClientChurn`) with the same options as before.
    - On error, treat as **non-fatal** (deploy still considered successful).

- `runChurnOnlyMode`
    - Use the existing churn-only logic, but moved into this helper:
        - Build local manifest.
        - Fetch remote manifest.
        - Compute churn and print summary.
        - In churn-only mode, churn failures should be **fatal** (exit with code 1).
    - Reuse the same churn output formatting, just extracted into helper(s) if needed.

### 2.3 Simplify `run()` to top-level story

Once helpers exist, reshape the core of `run()` to roughly:

```ts
const deploy: TDeployArgs = /* built as above */

if (deploy.verbose) {
    console.log(`Starting deploy for profile "${deploy.profileName}"...`)
}

if (deploy.churnOnly) {
    await runChurnOnlyMode(deploy)
    return
}

await runTestPhase(deploy)
await runBuildPhase(deploy)
await runSyncPhase(deploy)
await runPm2Phase(deploy)
await runChurnPhase(deploy)
```

Keep any start/end summary logs you already have, but ensure the **main narrative** is that simple.

---

## 3. Centralize error handling

### 3.1 Add two error helpers

In `src/cli.ts`, add:

```ts
function handleFatalError(label: string, err: unknown): never {
	const message = toErrorMessage(err)
	const code =
		err instanceof Error && typeof err.cause === "string"
			? err.cause
			: undefined

	if (code) {
		console.error(`${label} error [${code}]:`, message)
	} else {
		console.error(`${label} error:`, message)
	}

	process.exit(1)
}

function logNonFatalError(label: string, err: unknown): void {
	const message = toErrorMessage(err)
	const code =
		err instanceof Error && typeof err.cause === "string"
			? err.cause
			: undefined

	if (code) {
		console.error(
			`Deploy succeeded, but ${label} step failed [${code}]:`,
			message,
		)
	} else {
		console.error(`Deploy succeeded, but ${label} step failed:`, message)
	}
}
```

### 3.2 Use error helpers in phases

- In `runBuildPhase`, `runSyncPhase`, and `runChurnOnlyMode`:

```ts
try {
	// call module
} catch (err) {
	handleFatalError("Build", err)
}
```

(or `"Sync"`, `"Churn-only"`, etc.)

- In `runPm2Phase` and `runChurnPhase` (full deploy):

```ts
try {
	// call module
} catch (err) {
	logNonFatalError("PM2", err)
}
```

(or `"Churn"` for the post-deploy churn step).

### 3.3 Keep existing semantics

- **Fatal phases:**
    - Config resolution
    - Overrides
	- Tests
    - Build
    - Sync
    - Churn in `--churnOnly` mode  
      must still **exit with non-zero** (1) on failure.

- **Non-fatal phases:**
    - PM2 update
    - Churn in full deploy  
      should **never change the exit code**, only log.

---

## 4. Constraints and non-goals

- Do **not** change:
    - CLI flags or their meanings.
    - Behavior of `build`, `syncBuild`, `pm2`, or `churn` modules.
    - Dry-run semantics.
    - How churn metrics are computed or formatted, beyond moving formatting into helpers if needed.

- You **may**:
    - Move existing logic from `run()` into helpers.
    - Adjust logging for clarity, while keeping content equivalent.
