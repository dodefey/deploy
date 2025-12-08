# Build Module Specification (Full Text)

## 1. Purpose

The build module is responsible for **running a Nuxt production build** in a controlled, testable way.

It answers:

- “Given this project and environment, can we produce a fresh production build?”
- “If not, what clearly-typed error should we throw?”

It explicitly does **not** handle:

- Deploying the build anywhere
- Churn analysis
- PM2 management
- Legacy/atypical build flows

It is a small, focused piece that just runs the build and reports success or failure.

---

## 2. Interface

### 2.1 Function and options

Single entrypoint:

```ts
export type TBuildOutputMode = "inherit" | "silent" | "callbacks"

export interface TBuildOptions {
	// Base directory where the Nuxt project lives; defaults to process.cwd()
	rootDir?: string

	// How to invoke Nuxt; typically "npx" with args, but overridable for tests/CI
	nuxtBin?: string // default: "npx"
	nuxtArgs?: string[] // default: ["nuxt", "build", "--dotenv", ".env.production"]

	// Extra env to merge into process.env when spawning the build
	env?: Record<string, string>

	// How to handle build output
	// "inherit"  -> Nuxt output goes directly to parent stdio
	// "silent"   -> Nuxt stdout/stderr are ignored
	// "callbacks"-> Nuxt stdout/stderr are piped and forwarded line-by-line
	outputMode?: TBuildOutputMode // default: "inherit"

	// Optional callbacks when outputMode === "callbacks"
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export type TBuildErrorCode =
	| "BUILD_COMMAND_NOT_FOUND"
	| "BUILD_FAILED"
	| "BUILD_INTERRUPTED"

export function runNuxtBuild(options?: TBuildOptions): Promise<void>
```

### 2.2 Return type

- On success: resolves to `void`.
- On failure: rejects with `Error` where:
    - `err.message` is human-readable
    - `err.cause` is one of `TBuildErrorCode`.

There is **no structured success payload**; success is simply “did not throw.”

---

## 3. Defaults, minimal input, and output behavior

### 3.1 Defaults and minimal input

If the caller passes **no options**, the behavior is:

- `rootDir = process.cwd()`
- `nuxtBin = "npx"`
- `nuxtArgs = ["nuxt", "build", "--dotenv", ".env.production"]`
- `env = {}` (merged into `process.env`)

In other words, the typical project can just call:

```ts
await runNuxtBuild()
```

and get a production build equivalent to:

```bash
npx nuxt build --dotenv .env.production
```

from the project root.

Options exist only for:

- Overriding where the project lives (`rootDir`)
- Changing how Nuxt is invoked (`nuxtBin`, `nuxtArgs`)
- Tweaking environment (`env`)

### 3.2 Output and logging control

Although “logging” isn’t the module’s primary concern, the caller must be able to control where the **Nuxt build output** goes:

- Printed to the screen (normal dev/local use)
- Silenced (e.g., noisy CI)
- Captured and piped to a log file (for later inspection)

To support that **without** the build module itself knowing about files or UI, we define the following output behavior contract:

#### 1. Default behavior: inherit output

By default, `runNuxtBuild` should:

- Spawn the Nuxt process with **inherited stdio**, so that:
    - `stdout` and `stderr` from Nuxt flow directly to the parent process’s stdout/stderr.
- Not call `console.log` or `console.error` itself; it simply lets Nuxt talk.

This matches the current “normal” behavior when you run `npx nuxt build` in a terminal:  
you see Nuxt’s output in real time.

#### 2. Silent mode

The module must support a configuration where:

- The Nuxt child process is spawned with its output **ignored** (no printing to the terminal).
- The module still enforces success/failure by:
    - Inspecting the exit code,
    - Mapping errors to `TBuildErrorCode`,
    - Throwing on failure.

This is useful when the caller wants to suppress logs but still know whether the build succeeded.

#### 3. Callback-based output (for log piping)

The module must also support a configuration where:

- Nuxt’s `stdout` and `stderr` are **piped** to the parent.
- The module splits the streams into lines and invokes caller-provided callbacks:

```ts
onStdoutLine?: (line: string) => void
onStderrLine?: (line: string) => void
```

Behavior in this mode:

- The module itself does **not** decide where logs go.
- Each line is forwarded to the callback.
- The caller may:
    - Write lines to a log file,
    - Echo them to the console,
    - Send them to a remote logger,
    - Buffer them for error reporting,
    - Or ignore them entirely.

No changes to success semantics: success is still “did not throw.”

---

## 4. Detailed behavior

### 4.1 Command execution

- Use `child_process.spawn` to execute:
    - `nuxtBin` with `nuxtArgs`
    - Working directory: `rootDir`

- Environment:
    - Start from `process.env`
    - Overlay `options.env` if provided

- StdIO wiring:
    - Determined by the output behavior in Section 3.2
        - Inherit (default)
        - Silent
        - Pipe → callbacks

### 4.2 Error handling and exit codes

Error mapping rules:

- If `spawn` emits an `'error'` with `code === "ENOENT"` for `nuxtBin`:
    - Throw an `Error` with:
        - `err.cause === "BUILD_COMMAND_NOT_FOUND"`
        - `err.message` explaining the command could not be found.

- If the child process exits with a **non-zero exit code**:
    - Throw an `Error` with:
        - `err.cause === "BUILD_FAILED"`
        - `err.message` describing the failure and exit code.

- If the process terminates via **signal**:
    - Throw an `Error` with:
        - `err.cause === "BUILD_INTERRUPTED"`
        - `err.message` indicating the signal (e.g. SIGTERM).

- Unexpected internal errors are treated as:
    - `err.cause === "BUILD_FAILED"`

---

## 5. Logging and purity constraints

- The build module must **not** print high-level status messages itself.
- It does **not** print “Building…”, “Success!”, or similar UI messages.
- All human-facing text belongs to the caller (e.g., the CLI).

The module **only**:

1. Spawns the Nuxt process,
2. Wires its outputs according to the chosen output mode,
3. Resolves or rejects based on the exit result.

This keeps the module reusable and easy to test.

---

## 6. Testability

To make the module fully testable without running a real Nuxt build:

- Internally factor out a `spawn` abstraction:

```ts
type TSpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess
```

- In production: uses real `spawn`.
- In tests: use a fake implementation to simulate:
    - ENOENT errors,
    - Non-zero exit codes,
    - Signals,
    - Normal exit.

For output tests:

- Silent mode → verify correct stdio configuration.
- Callback mode → feed mock stdout/stderr and assert callback invocations.

---

## 7. What it does _not_ do

The build module intentionally does **not**:

- Implement a “dry run” (caller can skip the build call if needed).
- Handle deploy tasks:
    - No rsync/tar
    - No SSH
    - No PM2
- Handle churn or manifest generation.
- Support atypical or legacy build paths beyond configurable `nuxtArgs`.

It is strictly:

**“Run the Nuxt production build with the given options, let me control how Nuxt’s output is wired, and throw a typed error if anything goes wrong.”**
