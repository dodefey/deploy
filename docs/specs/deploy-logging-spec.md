# deployLogging Module Specification

## 1. Purpose

The `deployLogging` module centralizes **all logging behavior** for the deploy CLI.

It is responsible for:

- Turning deploy events and errors into **human-readable log lines**.
- Sending those lines to a **pluggable logging sink** (default: console).
- Enforcing the **logging and error format contracts** defined in the logging and error taxonomy specs.

It does **not**:

- Decide exit codes (`process.exit` never appears here).
- Orchestrate phases (build/sync/PM2/churn); that stays in `main.ts`.
- Perform network, filesystem, or deploy logic.

`main.ts` should not call `console.log`/`console.error` directly.  
Instead, it calls functions in `deployLogging`, which handle both formatting and output.

---

## 2. Logger Sink Abstraction

### 2.1 TLoggerSink

```ts
export interface TLoggerSink {
	info(line: string): void
	error(line: string): void
}
```

### 2.2 Default sink

```ts
const consoleSink: TLoggerSink = {
	info: (line) => console.log(line),
	error: (line) => console.error(line),
}
```

### 2.3 Current sink and setter

```ts
let currentSink: TLoggerSink = consoleSink

export function setLoggerSink(sink: TLoggerSink | null | undefined): void
```

Behavior:

- If `sink` is valid, use it.
- If `null` or `undefined`, reset to `consoleSink`.

---

## 3. Context Types

```ts
export interface TLogContext {
	profileName?: string
}

export interface TPm2Context extends TLogContext {
	appName: string
	restartMode: "startOrReload" | "reboot"
	instanceCount: number
}
```

---

## 4. Error Interpretation Utilities

### 4.1 extractErrorCode

```ts
export function extractErrorCode(err: unknown): string | undefined
```

Rules:

- Return `err.cause` if it exists and is a string.
- Else return `undefined`.

### 4.2 toErrorMessage

```ts
export function toErrorMessage(err: unknown): string
```

Rules:

- If `Error`, return `message`.
- Else `String(err)`.

---

## 5. Error Formatting Helpers (Pure)

### 5.1 formatFatalError

```ts
export function formatFatalError(
	label: string,
	code: string | undefined,
	message: string,
	profileName?: string,
): string
```

Rules:

- With code + profile:

    ```
    <label> error [<CODE>] (profile="<PROFILE_NAME>"): <message>
    ```

- With code only:

    ```
    <label> error [<CODE>]: <message>
    ```

- With profile only:

    ```
    <label> error (profile="<PROFILE_NAME>"): <message>
    ```

- With neither:

    ```
    <label> error: <message>
    ```

### 5.2 formatNonFatalError

```ts
export function formatNonFatalError(
	label: string,
	code: string | undefined,
	message: string,
	profileName?: string,
): string
```

Rules:

- With code + profile:

    ```
    Deploy succeeded, but <label> step failed [<CODE>] (profile="<PROFILE_NAME>"): <message>
    ```

- With code only:

    ```
    Deploy succeeded, but <label> step failed [<CODE>]: <message>
    ```

- With profile only:

    ```
    Deploy succeeded, but <label> step failed (profile="<PROFILE_NAME>"): <message>
    ```

- With neither:

    ```
    Deploy succeeded, but <label> step failed: <message>
    ```

---

## 6. Public Logging API (Used by main.ts)

### 6.1 Deploy lifecycle logs

```ts
export function logDeployStart(ctx: TLogContext): void
export function logDeploySuccess(ctx: TLogContext): void
export function logChurnOnlyStart(ctx: TLogContext): void
export function logChurnOnlySuccess(ctx: TLogContext): void
```

Behavior:

- logDeployStart:

    ```
    [deploy] Starting deploy for profile "<PROFILE_NAME>"...
    ```

- logDeploySuccess:

    ```
    [deploy] Deploy completed successfully for profile "<PROFILE_NAME>".
    ```

- logChurnOnlyStart:

    ```
    [deploy] Starting churn-only run for profile "<PROFILE_NAME>"...
    ```

- logChurnOnlySuccess:

    ```
    [deploy] Churn-only run completed successfully for profile "<PROFILE_NAME>".
    ```

Fallback if no profileName:

```
[deploy] Starting deploy...
[deploy] Deploy completed successfully.
[deploy] Starting churn-only run...
[deploy] Churn-only run completed successfully.
```

---

### 6.2 Phase progress logs

```ts
export function logPhaseStart(name: string): void
export function logPhaseSuccess(message: string): void
```

- logPhaseStart:

    ```
    [deploy] <name>...
    ```

- logPhaseSuccess:

    ```
    [deploy] <message>
    ```

---

### 6.3 PM2 success logs

```ts
export function logPm2Success(ctx: TPm2Context): void
```

Expected output:

```
[deploy] PM2 update complete for "<APP_NAME>": <INSTANCE_COUNT> instances online (mode: <RESTART_MODE>).
```

---

### 6.4 Churn summary logs

```ts
export function logChurnSummary(
	metrics: TChurnMetrics,
	options?: TChurnDisplayOptions,
): void
```

Behavior:

- Format using `formatChurnMetrics`.
- Output using `currentSink.info`.

---

### 6.5 Error logs

#### logFatalError

```ts
export function logFatalError(
	label: string,
	err: unknown,
	ctx?: TLogContext,
): void
```

Steps:

1. Extract code and message.
2. Format using `formatFatalError`.
3. Log via `currentSink.error`.

No exit.

#### logNonFatalError

```ts
export function logNonFatalError(
	label: string,
	err: unknown,
	ctx?: TLogContext,
): void
```

Steps:

1. Extract code and message.
2. Format using `formatNonFatalError`.
3. Log via `currentSink.error`.

No exit.

---

## 7. Integration Rules for main.ts

After this module is implemented:

- **main.ts must never call** `console.log` or `console.error` directly.
- All logging goes through:
    - logDeployStart / logDeploySuccess
    - logChurnOnlyStart / logChurnOnlySuccess
    - logPhaseStart / logPhaseSuccess
    - logPm2Success
    - logChurnSummary
    - logFatalError / logNonFatalError
- Fatal exit remains in main:

```ts
function handleFatalError(label, err, profileName): never {
	logFatalError(label, err, { profileName })
	process.exit(1)
}
```

---

## 8. Testability

- Formatters have pure snapshot tests.
- Logging functions can be tested using a custom sink via `setLoggerSink`.
- No filesystem or network dependencies.
- No side effects beyond the sink.

---

## 9. Future Extensions

- Optional debug/warn levels.
- Optional structured logging sink (e.g. pino).
- Optional inclusion of env/dryRun flags in context.

For now, the module is strictly:

> “Format and log all deploy-related messages through a pluggable sink without deciding exit behavior.”
