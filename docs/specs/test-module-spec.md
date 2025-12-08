# Test Module Specification

## 1. Purpose

The test module is responsible for **running the project test suite in a controlled, reusable way** before a deploy.

It answers:

- “Can this project’s tests pass right now?”
- “If not, what clearly-typed error should we throw?”

It explicitly does **not** handle:

- Deciding _whether_ to deploy (that is `main.ts`’s job).
- Any build, sync, PM2, or churn logic.
- Remote test execution (tests run locally where the CLI is invoked).
- CLI parsing or profile selection.

It is a small, focused piece that just runs the tests and reports success or failure.

---

## 2. Interface

### 2.1 Types

Single entrypoint and options, mirroring the build module’s style:

```ts
export type TTestOutputMode = "inherit" | "silent" | "callbacks"

export interface TTestOptions {
	// Base directory where the project lives; defaults to process.cwd()
	rootDir?: string

	// How to invoke the test runner; overridable for tests/CI
	// Default command is equivalent to running `npm test` in the project root
	testBin?: string // default: "npm"
	testArgs?: string[] // default: ["test"]

	// Extra env to merge into process.env when spawning the tests
	env?: Record<string, string>

	// How to handle test output
	// "inherit"   -> test output goes directly to parent stdio
	// "silent"    -> test stdout/stderr are ignored
	// "callbacks" -> test stdout/stderr are piped and forwarded line-by-line
	outputMode?: TTestOutputMode // default: "inherit"

	// Optional callbacks when outputMode === "callbacks"
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export type TTestErrorCode =
	| "TEST_COMMAND_NOT_FOUND"
	| "TEST_FAILED"
	| "TEST_INTERRUPTED"

export function runTests(options?: TTestOptions): Promise<void>
```

### 2.2 Return type

- On success: resolves to `void` (tests passed).
- On failure: rejects with `Error` where:
    - `err.message` is human-readable.
    - `err.cause` is one of `TTestErrorCode`.

There is **no structured success payload**; success is simply “tests completed without errors.”

---

## 3. Defaults, minimal input, and output behavior

### 3.1 Defaults and minimal input

If the caller passes **no options**, the behavior is:

- `rootDir = process.cwd()`
- `testBin = "npm"`
- `testArgs = ["test"]`
- `env = {}` (merged into `process.env`)
- `outputMode = "inherit"`

In other words, the typical project can just call:

```ts
await runTests()
```

and get an execution equivalent to:

```bash
npm test
```

from the project root.

Options exist only for:

- Overriding where the project lives (`rootDir`).
- Changing how the tests are invoked (`testBin`, `testArgs`).
- Tweaking environment (`env`).
- Controlling how test output is surfaced (`outputMode`, callbacks).

### 3.2 Output and logging control

Although “logging” isn’t the module’s primary concern, the caller must be able to control where the **test runner output** goes:

- Printed directly to the terminal (normal local use).
- Silenced (e.g., very noisy CI environments).
- Captured and piped to a log file or logger.

To support that **without** the test module itself knowing about files or UI, we define the following output behavior contract:

#### 1. Default behavior: inherit output

By default, `runTests` should:

- Spawn the test process with **inherited stdio**, so that:
    - `stdout` and `stderr` from the test runner flow directly to the parent process’s stdout/stderr.
- Not call `console.log` or `console.error` itself; it simply lets the test runner talk.

This matches the normal behavior when you run `npm test` in a terminal:  
you see the test output in real time.

#### 2. Silent mode

The module must support a configuration where:

- The test child process is spawned with its output **ignored** (no printing to the terminal).
- The module still enforces success/failure by:
    - Inspecting the exit code,
    - Mapping errors to `TTestErrorCode`,
    - Throwing on failure.

This is useful when the caller wants to suppress logs but still know whether tests passed.

#### 3. Callback-based output (for log piping)

The module must also support a configuration where:

- Test runner `stdout` and `stderr` are **piped** to the parent.
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

- Use `child_process.spawn` (or an internal abstraction) to execute:
    - `testBin` with `testArgs`.
    - Working directory: `rootDir`.

- Environment:
    - Start from `process.env`.
    - Overlay `options.env` if provided.

- StdIO wiring:
    - Determined by the output behavior in Section 3.2:
        - Inherit (default).
        - Silent.
        - Pipe → callbacks.

### 4.2 Error handling and exit codes

Error mapping rules (mirroring the build module):

- If `spawn` emits an `"error"` with `code === "ENOENT"` for `testBin`:
    - Throw an `Error` with:
        - `err.cause === "TEST_COMMAND_NOT_FOUND"`.
        - `err.message` explaining the command could not be found.

- If the child process exits with a **non-zero exit code**:
    - Throw an `Error` with:
        - `err.cause === "TEST_FAILED"`.
        - `err.message` describing the failure and exit code.

- If the process terminates via **signal**:
    - Throw an `Error` with:
        - `err.cause === "TEST_INTERRUPTED"`.
        - `err.message` indicating the signal (e.g., `SIGTERM`).

- Unexpected internal errors are treated as:
    - `err.cause === "TEST_FAILED"`.

### 4.3 Interaction with main.ts

The test module itself does **not** know about deploy phases. `main.ts` is responsible for:

- Deciding **when** tests run (e.g., before build).
- Deciding **when** tests are required vs optional.
- Mapping test failures to **fatal deploy failures**:
    - `runTestsPhase` will call `handleFatalError("Tests", err, profileName)` on any `runTests` rejection, regardless of the specific `TTestErrorCode`.

- Wiring `outputMode` and callbacks based on CLI flags like `--verbose`.

---

## 5. Logging and purity constraints

- The test module must **not** print high-level status messages itself.
- It does **not** print “Running tests…”, “Tests passed!”, or similar UI messages.
- All human-facing status text belongs to the caller (e.g., the CLI / `deployLogging`).

The module **only**:

1. Spawns the test runner process.
2. Wires its outputs according to the chosen output mode.
3. Resolves or rejects based on the exit result.

This keeps the module reusable and easy to test.

---

## 6. Testability

To make the module fully testable without running a real test suite:

- Internally factor out a `spawn` abstraction, analogous to the build module:

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

The test module intentionally does **not**:

- Implement a “dry run” concept (that is a deploy-level concern; `main.ts` decides whether to call `runTests` at all).
- Inspect or alter deploy profiles (`test`, `prod`, etc.).
- Run tests on a remote server (always local to where the CLI runs).
- Implement any build, sync, PM2, or churn logic.
- Parse CLI flags (it only consumes a typed options object).

It is strictly:

**“Run the test suite with the given options, let me control how the test output is wired, and throw a typed error if anything goes wrong.”**
