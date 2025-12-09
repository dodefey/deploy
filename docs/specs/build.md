# Build Module Specification (Full Text)

## 1. Purpose

The build module is a **generic command runner** for build steps. It owns:

- Spawning a build command with a provided binary and arguments.
- Output wiring (inherit, silent, callbacks with line buffering).
- Typed error mapping for missing commands, non-zero exits, and signals.

It does **not** know about Nuxt or any framework-specific defaults. Callers must provide the command to run.

---

## 2. Interface

### 2.1 Function and options

Single entrypoint:

```ts
export type TBuildOutputMode = "inherit" | "silent" | "callbacks"

export interface TBuildCommand {
	command: string // e.g. "npx", "pnpm"
	args: string[] // e.g. ["nuxt", "build", "--dotenv", ".env.production"]
}

export interface TBuildOptions {
	// Working directory for the process; defaults to process.cwd()
	rootDir?: string

	// Extra env to merge into process.env when spawning the build
	env?: Record<string, string>

	// How to handle build output
	// "inherit"  -> child stdout/stderr inherit
	// "silent"   -> ignore stdout/stderr
	// "callbacks"-> pipe and forward line-by-line
	outputMode?: TBuildOutputMode // default: "inherit"

	// Optional callbacks when outputMode === "callbacks"
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export type TBuildErrorCode =
	| "BUILD_COMMAND_NOT_FOUND"
	| "BUILD_FAILED"
	| "BUILD_INTERRUPTED"

export function runBuild(
	command: TBuildCommand,
	options?: TBuildOptions,
): Promise<void>
```

### 2.2 Return type

- On success: resolves to `void`.
- On failure: rejects with `Error` where:
    - `err.message` is human-readable
    - `err.cause` is one of `TBuildErrorCode`.

There is **no structured success payload**; success is simply “did not throw.”

---

## 3. Inputs, defaults, and output behavior

### 3.1 Required command

- The caller **must** provide `command` and `args`. There is **no default build command**.
- Minimal call example:

```ts
await runBuild({ command: "npx", args: ["nuxt", "build"] })
```

### 3.2 Option defaults

If the caller omits options:

- `rootDir = process.cwd()`
- `env = {}` (merged into `process.env`)
- `outputMode = "inherit"`

### 3.3 Output and logging control

The build module controls only process stdio wiring. It does **not** log status messages itself.

1. **inherit** (default): spawn with inherited stdio so child output appears in the parent terminal.
2. **silent**: spawn with stdout/stderr ignored.
3. **callbacks**: pipe stdout/stderr, split into lines, and invoke callbacks per line.
    - If `outputMode === "callbacks"` but no callbacks are provided, output is effectively discarded (pipes are wired, but no handlers run).

Success semantics are unchanged across modes; output handling is orthogonal.

---

## 4. Detailed behavior

### 4.1 Command execution

- Use `child_process.spawn` to execute `command.command` with `command.args` in `rootDir`.
- Environment merges `process.env` with `options.env`.
- StdIO is determined by `outputMode` (inherit | silent | callbacks).

### 4.2 Error handling and exit codes

- `spawn` `'error'` with `code === "ENOENT"` → `cause = "BUILD_COMMAND_NOT_FOUND"` with message naming the missing command.
- Child exits with **non-zero exit code** → `cause = "BUILD_FAILED"` and message noting the exit code.
- Child terminates via **signal** → `cause = "BUILD_INTERRUPTED"` and message noting the signal.
- Other spawn errors map to `BUILD_FAILED`.

---

## 5. Logging and purity constraints

- No console output or status messages are emitted by this module.
- Responsibilities are limited to spawning, output wiring, and error mapping.
- Callers own user-facing logging.

---

## 6. Testability

- Internal `spawn` abstraction:

```ts
type TSpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess
```

- Production uses real `spawn`; tests may inject a fake via `spawnImpl` to simulate ENOENT, signals, non-zero exits, or normal success.
- For output tests: assert stdio wiring for each mode and line-buffered callback delivery.

---

## 7. Non-goals

- No dry-run mode (callers may skip invoking the build).
- No deploy responsibilities (no rsync/SSH/PM2/churn).
- No framework-specific defaults; callers must supply the command and args they want executed.
