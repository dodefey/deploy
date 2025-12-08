# Churn Format Helper Specification

## 1. Purpose

The churn format helper is responsible for **turning raw churn metrics into a human-readable, multi-line summary string** suitable for CLI output.

It answers:

- “Given `TChurnMetrics`, what should we print for the user?”
- “How do we consistently phrase baseline/dry-run context?”
- “How do we present file/byte percentages and totals?”

It does **not**:

- Compute churn (no file system, no SSH, no manifest logic).
- Log anything by itself (no `console.log`).
- Decide where the output is shown (terminal vs log file).

It is a **pure presentation helper** that consumes `TChurnMetrics` and simple options, and returns a formatted string.

---

## 2. Interface

### 2.1 Types

The module builds on the existing `TChurnMetrics` type from `churn.ts`:

```ts
export interface TChurnMetrics {
	totalOldFiles: number
	totalNewFiles: number
	stableFiles: number
	changedFiles: number
	addedFiles: number
	removedFiles: number

	totalOldBytes: number
	totalNewBytes: number
	stableBytes: number
	changedBytes: number
	addedBytes: number
	removedBytes: number

	downloadImpactFilesPercent: number
	cacheReuseFilesPercent: number
	downloadImpactBytesPercent: number
	cacheReuseBytesPercent: number
}
```

The format helper introduces:

```ts
export interface TChurnDisplayOptions {
	dryRun?: boolean
}
```

### 2.2 Public API

Single main entrypoint:

```ts
export function formatChurnMetrics(
	metrics: TChurnMetrics,
	options?: TChurnDisplayOptions,
): string
```

- Input:
    - `metrics`: the raw churn data returned by `computeClientChurn`.
    - `options.dryRun`: whether the churn run is a dry run.

- Output:
    - A **multi-line string** with exactly 3 lines:
        1. Header
        2. Files line
        3. Bytes line

The function:

- Does not mutate its inputs.
- Does not perform any I/O.

---

## 3. Output Structure and Formatting Rules

### 3.1 Overall shape

`formatChurnMetrics` returns:

```
Client cache impact (...context...)
  Files: <downloadPercent>% new/changed, <reusePercent>% reused (<details...>)
  Bytes: <downloadPercent>% new/changed, <reusePercent>% reused (<details...>)
```

Specifically:

1. **Header line** (contextual label).
2. **Files line** (percentages + counts).
3. **Bytes line** (percentages + byte sizes).

Lines are joined with `\n` (LF) and **no trailing newline** at the end of the string.

---

### 3.2 Header line

Header is determined by:

- Whether a previous baseline exists
- Whether this run is a dry run

Definitions:

- `hasBaseline = metrics.totalOldFiles > 0 || metrics.totalOldBytes > 0`
- `isDryRun = options?.dryRun === true`

This definition of `hasBaseline` matches the churn module’s behavior: a baseline is considered present if either old file count or old byte count is non-zero. The format helper does not attempt to validate consistency between file and byte totals; it assumes `TChurnMetrics` has already been computed correctly and simply interprets `hasBaseline` using this OR rule.

Rules:

1. No baseline, dry run:

```
Client cache impact (no previous baseline, dry run; baseline not updated)
```

2. No baseline, live:

```
Client cache impact (no previous baseline)
```

3. Baseline present, dry run:

```
Client cache impact (dry run; baseline not updated)
```

4. Baseline present, live:

```
Client cache impact
```

These exact strings are considered stable, human-facing API for the CLI.

---

### 3.3 Files line

Format:

```
  Files: <downloadImpactFilesPercent>% new/changed, <cacheReuseFilesPercent>% reused (<details>)
```

Where:

- `<downloadImpactFilesPercent>` = `metrics.downloadImpactFilesPercent`
- `<cacheReuseFilesPercent>` = `metrics.cacheReuseFilesPercent`

These percentages and counts are assumed to be precomputed by the churn module. The format helper does not perform any divide-by-zero checks or recalculate percentages; it trusts the invariants of `TChurnMetrics` and simply formats the supplied values.

Formatting:

- One decimal place.
- Rounded to nearest 0.1.
- Always printed with exactly one decimal (e.g. `0.0`, `12.3`, `100.0`).

Details:

```
(<changedFiles> changed, <addedFiles> added, <removedFiles> removed; <totalOldFiles> -> <totalNewFiles> files)
```

Indentation:

- Begins with two spaces: `"  Files: ..."`

---

### 3.4 Bytes line

Format:

```
  Bytes: <downloadImpactBytesPercent>% new/changed, <cacheReuseBytesPercent>% reused (<details>)
```

Byte values use a human-friendly formatter. The `bytes` inputs passed into `formatBytes` are raw byte counts from `TChurnMetrics` (e.g. values ultimately derived from filesystem statistics), not pre-scaled KB/MB values:

- `<x> KB` for < 1 MB
- `<x> MB` otherwise (no GB required)

Details:

```
(<changedBytes> changed, <addedBytes> added, <removedBytes> removed; <totalOldBytes> -> <totalNewBytes>)
```

Indentation:

- Begins with two spaces: `"  Bytes: ..."`

---

### 3.5 Percent formatting helper

```ts
function formatPercent(value: number): string
```

Rules:

- `rounded = Math.round(value * 10) / 10`
- `return rounded.toFixed(1)`

### 3.6 Byte formatting helper

```ts
function formatBytes(bytes: number): string
```

Rules:

- ≤ 0 → `"0.0 KB"`
- `< 1024 KB` → KB with 1 decimal
- else → MB with 1 decimal

---

## 4. Behavior Details

### 4.1 No I/O

- No console output.
- No file output.
- Pure function.

### 4.2 Error handling

- Throws normal errors for invalid inputs.
- No typed error codes.

---

## 5. Examples

### 5.1 No baseline, live

```
Client cache impact (no previous baseline)
  Files: 100.0% new/changed, 0.0% reused (0 changed, 10 added, 0 removed; 0 -> 10 files)
  Bytes: 100.0% new/changed, 0.0% reused (0.0 KB changed, 100.0 KB added, 0.0 KB removed; 0.0 KB -> 100.0 KB)
```

### 5.2 Baseline, dry run

Header becomes:

```
Client cache impact (dry run; baseline not updated)
```

Other lines unchanged.

---

## 6. Testability

Should be fully unit-testable:

- Header cases (4)
- Percentage edge cases
- Byte formatting
- Full snapshot string tests

No mocking of SSH or filesystem required.

---

## 7. Non-Goals & Future Extensions

Non-goals:

- No CLI decisions
- No JSON output
- No i18n

Possible future:

- Structured output (`{ header, filesLine, bytesLine }`)
- GB support if bundles grow
