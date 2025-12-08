# Error Taxonomy & Documentation

## 1. Purpose

The deploy CLI must provide:

- **Discoverable** error behavior: all structured error codes appear in one place.
- **Predictable** error categorization: each error belongs to a defined phase.
- **Consistent** error formatting across all modules and main.ts.
- **Understandable** failure modes: users can tell what succeeded or failed in the deploy sequence.

This spec defines:

1. The **error taxonomy** (codes & categories).
2. How and where error codes must be **documented**.
3. Rules for **error.cause** propagation.
4. Required **log formatting** for fatal and non-fatal errors.
5. Category-level **failure modes**.
6. **main.ts** responsibilities regarding error handling.

---

# 2. Documentation Layout

## 2.1 Central Error Document (`ERRORS.md`)

A top-level file named **ERRORS.md** must serve as the canonical reference for all error codes.

It must include:

### A. Introduction

Explanation of:

- What an error code is (a string stored in `error.cause`).
- Only **intentional** module error paths set a string code.
- Unknown/unexpected errors do **not** get a code.
- main.ts displays the code when present; logs without `[CODE]` when absent.

### B. Sections grouped by module category

- Include the union type:
    ```ts
    export type TSyncBuildErrorCode =
    	| "SYNC_NO_LOCAL_OUTPUT_DIR"
    	| "SYNC_SSH_FAILED"
    	| "SYNC_RSYNC_FAILED"
    ```
- List the codes with short descriptions.
- Include a required **"Impact on deploy"** subsection.

Categories:

1. Config
2. Build
3. Sync
4. PM2
5. Churn

### C. Optional per-code notes

Allowed but not required.

---

## 2.2 Module Specification Requirements

Each module spec file must include an **Errors** section listing:

- The union type name
- All codes the module throws
- A pointer to ERRORS.md

Example:

```
Errors:
- BUILD_NUXT_FAILED
- BUILD_SPAWN_FAILED
See ERRORS.md for descriptions and deploy impact.
```

---

# 3. Error Taxonomy

## 3.1 Category Unions

### Config

```ts
export type TConfigErrorCode =
	| "CONFIG_PROFILE_FILE_NOT_FOUND"
	| "CONFIG_PROFILE_NOT_FOUND"
	| "CONFIG_DUPLICATE_PROFILE"
	| "CONFIG_PROFILE_INVALID"
	| "CONFIG_INVALID_RESTART_MODE"
```

### Build

```ts
export type TBuildErrorCode =
	| "BUILD_COMMAND_NOT_FOUND"
	| "BUILD_FAILED"
	| "BUILD_INTERRUPTED"
```

### Sync

```ts
export type TSyncBuildErrorCode =
	| "SYNC_NO_LOCAL_OUTPUT_DIR"
	| "SYNC_SSH_FAILED"
	| "SYNC_RSYNC_FAILED"
```

### PM2

```ts
export type TPM2ErrorCode =
	| "PM2_SSH_FAILED"
	| "PM2_CONFIG_COMPARE_FAILED"
	| "PM2_CONFIG_UPLOAD_FAILED"
	| "PM2_COMMAND_FAILED"
	| "PM2_STATUS_QUERY_FAILED"
	| "PM2_HEALTHCHECK_FAILED"
```

### Churn

```ts
export type TChurnErrorCode =
	| "CHURN_NO_CLIENT_DIR"
	| "CHURN_REMOTE_MANIFEST_FETCH_FAILED"
	| "CHURN_REMOTE_MANIFEST_UPLOAD_FAILED"
	| "CHURN_COMPUTE_FAILED"
```

---

## 3.2 Config Errors: Two-Tier Model

Config errors are all string literals of the form CONFIG\_\*. Conceptually they fall into two buckets:

### 1. Profile not found

Covers cases where:

- profiles.json is missing, unreadable (I/O error), JSON-parse-invalid, not an array, or empty
- The requested profile name does not exist in the validated, non-empty list

These cases are represented by CONFIG_PROFILE_FILE_NOT_FOUND (missing/unreadable/invalid/empty source) and CONFIG_PROFILE_NOT_FOUND (name not present in a non-empty list).

### 2. Profile invalid / misconfigured

Covers cases where:

- Required fields are missing
- Required fields are empty/whitespace
- Values are structurally invalid (e.g., pm2RestartMode has an unsupported value)

These cases are represented by specific CONFIG\_\* codes such as:

- CONFIG_DUPLICATE_PROFILE
- CONFIG_PROFILE_INVALID — Required profile fields (sshConnectionString, remoteDir, env, pm2AppName) are missing or empty after trimming.
- CONFIG_INVALID_RESTART_MODE

Messages must explain the specific error.

All required profile fields are validated via a central descriptor table. Adding a new required field should reuse `CONFIG_PROFILE_INVALID` and add a descriptor entry; avoid ad-hoc checks.

---

## 3.3 Unknown / Unexpected Errors

Rules:

- Unknown errors do **not** receive synthetic codes.
- They appear without `[CODE]` in log output.

Example:

```
Build error: unexpected JSON parsing failure
```

ERRORS.md must explicitly state this behavior.

## 3.4 Naming Convention

All module error codes must:

- Be UPPER_SNAKE_CASE string literals.
- Start with a module prefix and underscore, e.g. CONFIG*\*, BUILD*\_, SYNC\_\_, PM2*\*, CHURN*\*.
- Live in exactly one category union (TConfigErrorCode, TBuildErrorCode, TSyncBuildErrorCode, TPM2ErrorCode, TChurnErrorCode).

When naming or renaming codes:

- Prefer normalizing existing codes into the appropriate module-prefixed form (e.g. NO_CLIENT_DIR → CHURN_NO_CLIENT_DIR) rather than adding brand new codes.
- Do not introduce new error codes without adding them to the appropriate union and documenting them in ERRORS.md.

---

# 4. Rules for `error.cause`

## 4.1 Module Requirements

Modules must:

1. Create an `Error` with a human-readable message.
2. Assign `err.cause = "<STRING_LITERAL_CODE>"`.
3. Throw.

Example:

```ts
const err = new Error("rsync exited with code 23")
err.cause = "SYNC_RSYNC_FAILED"
throw err
```

Modules must never:

- Mutate others’ error codes
- Invent new codes
- Wrap errors unless specified in their own spec

Additionally, modules must:

- Use only module-prefixed codes defined in their union (CONFIG*\*, BUILD*\_, SYNC\_\_, PM2*\*, CHURN*\*).
- Avoid throwing bare or unprefixed codes (e.g. "NO_CLIENT_DIR"); such cases should be normalized to the appropriate module-prefixed code.
- Prefer normalizing behavior into existing codes over expanding the error set; new codes should be introduced only when a genuinely new failure mode is needed, and must be added to the union and ERRORS.md.

---

## 4.2 main.ts Requirements

main.ts must:

- Treat `error.cause` as **read-only** for string error codes.
- Never invent or change string error codes (except for the config-wrapping behavior described in 4.2.1, which preserves existing codes and never assigns new string codes).

### 4.2.1 Exception: Config Wrapping

main.ts wraps config errors for clarity _but preserves the code if present_.

```ts
const code =
	err instanceof Error && typeof err.cause === "string"
		? err.cause
		: undefined

const message = toErrorMessage(err)

const wrapped = new Error(
	code
		? `Config error [${code}] for profile "${profileName}": ${message}`
		: `Config error for profile "${profileName}": ${message}`,
)

wrapped.cause = code ?? err
throw wrapped
```

Rules:

- If inner error had a code → preserve it.
- If not → wrapped.cause = original error object.
- No other wrapping may alter `cause`.

---

# 5. Required Error Log Formatting

main.ts must output fatal and non-fatal errors in consistent, structured formats. When a profile name is known, the “code + profile” form is the required default.

## 5.1 Fatal Error Format

Called via:

```ts
handleFatalError(label, err, profileName?)
```

### Formats:

#### With code + profile:

```
<label> error [CODE] (profile="PROFILE_NAME"): MESSAGE
```

#### With code only:

```
<label> error [CODE]: MESSAGE
```

#### With profile only:

```
<label> error (profile="PROFILE_NAME"): MESSAGE
```

#### With neither:

```
<label> error: MESSAGE
```

Fatal errors must call:

```
process.exit(1)
```

---

## 5.2 Non-Fatal Error Format

Called via:

```ts
logNonFatalError(label, err, profileName?)
```

### Formats:

#### Code + profile:

```
Deploy succeeded, but <label> step failed [CODE] (profile="PROFILE_NAME"): MESSAGE
```

#### Code only:

```
Deploy succeeded, but <label> step failed [CODE]: MESSAGE
```

#### Profile only:

```
Deploy succeeded, but <label> step failed (profile="PROFILE_NAME"): MESSAGE
```

#### Neither:

```
Deploy succeeded, but <label> step failed: MESSAGE
```

Non-fatal errors must **not** change the exit code.
main.ts must include the profile name in error logs when a profile has been resolved; if no profile is available, use the appropriate no-profile variant above.

---

# 6. Failure Modes (Deploy Impact)

Document these sections in ERRORS.md.

## 6.1 CONFIG\_\*

Fatal.  
Impact:

- Build not attempted
- Sync not attempted
- PM2 not attempted
- Churn not attempted
- Server unchanged

## 6.2 BUILD\_\*

Fatal.  
Impact:

- Build attempted and failed
- Sync/PM2/Churn skipped
- Server unchanged

## 6.3 SYNC\_\*

Fatal.  
Impact:

- Build succeeded
- Sync failed
- PM2 + Churn skipped
- Server unchanged

## 6.4 PM2\_\*

Non-fatal.  
Impact:

- Deploy succeeded
- PM2 update failed; app may be unhealthy
- Churn still runs
- Exit code remains 0

## 6.5 CHURN\_\* (full deploy)

Non-fatal.  
Impact:

- Deploy succeeded
- Churn failed
- Exit code remains 0

## 6.6 CHURN\_\* (churn-only)

Fatal.  
Impact:

- No deploy attempted
- Churn failed
- Exit code = 1

---

# 7. main.ts Responsibilities Summary

main.ts must:

### 1. Never mutate or create error codes

(except preserving config codes during wrapping)

### 2. Apply formatting rules (section 5)

### 3. Include profileNames in logs when available

### 4. Enforce fatal vs non-fatal categories

- Fatal: config, build, sync, churn-only
- Non-fatal: PM2, churn-in-deploy

### 5. Exit semantics

- Deploy success → exit(0)
- Unexpected top-level errors → caught and exit(1)
