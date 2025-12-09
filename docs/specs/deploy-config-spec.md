# Deploy Config Module Specification

Version 1.0

## 1. Purpose

The deploy config module is the **single source of truth for environment-level deploy settings** (profiles like “test” and “prod”). It is responsible for:

- Defining **named deploy profiles** (`test`, `prod`, etc.).
- Returning the **list of available profile names**.
- Returning a **fully resolved configuration** for a given profile name (merging profile data with module defaults).
- Validating that all required fields are present and well-formed.
- Surface configuration errors via **typed error codes**.

It does **not**:

- Decide which profile to use for a given CLI run (that’s `main.ts`).
- Know about runtime flags like `dryRun`, `skipBuild`, `verbose`, `churnOnly`.
- Read from `.env` or environment variables in this initial version.

## 2. Scope and Non-Goals

### 2.1 In Scope

- Define a **small set of profile objects** describing deploy environments.
- Provide a minimal API:
    - `listProfiles()` → names.
    - `resolveProfile(name)` → fully resolved config.
- Perform **validation** and throw **typed errors** for invalid configuration.
- Remain **easily extensible** to add more environment-level settings later.

### 2.2 Out of Scope

- Parsing CLI arguments.
- Choosing the default profile.
- Handling runtime behavior flags.
- Reading/writing `.env`.

## 3. Types

### 3.1 TProfile

```ts
export interface TProfile {
	name: string
	sshConnectionString: string
	remoteDir: string
	env: string
	pm2AppName: string

	buildDir?: string
	pm2RestartMode?: "startOrReload" | "reboot"
}
```

### 3.2 TProfileName

```ts
export type TProfileName = TProfile["name"]
```

### 3.3 TResolvedConfig

```ts
export interface TResolvedConfig {
	name: TProfile["name"]
	sshConnectionString: string
	remoteDir: string
	buildDir: string
	env: string
	pm2AppName: string
	pm2RestartMode: "startOrReload" | "reboot"
}
```

### 3.4 TConfigErrorCode

```ts
export type TConfigErrorCode =
	| "CONFIG_PROFILE_FILE_NOT_FOUND"
	| "CONFIG_PROFILE_NOT_FOUND"
	| "CONFIG_DUPLICATE_PROFILE"
	| "CONFIG_PROFILE_INVALID"
	| "CONFIG_INVALID_RESTART_MODE"
```

## 4. Public API

### 4.1 listProfiles

```ts
export function listProfiles(): TProfileName[]
```

### 4.2 resolveProfile

```ts
export function resolveProfile(name: TProfileName): TResolvedConfig
```

## 5. Behavior Details

### 5.1 Profile storage

- Profiles are loaded **at runtime** from `profiles.json` located in the current working directory (i.e., the project root where the CLI is invoked). Callers may override the path with `DEPLOY_PROFILES_PATH`. The parsed array is cached after the first successful read.
- File I/O errors, JSON parse failures, non-array content, or an empty array all map to `CONFIG_PROFILE_FILE_NOT_FOUND` with the message `"profiles.json is missing, invalid, or empty; expected at least one deploy profile"`.

Example:

```ts
const PROFILES: TProfile[] = [
	{
		name: "test",
		sshConnectionString: "user@example.com",
		remoteDir: "/var/www/app",
		env: "test",
		pm2AppName: "MyAppTest",
	},
	{
		name: "prod",
		sshConnectionString: "user@example.com",
		remoteDir: "/var/www/app",
		env: "production",
		pm2AppName: "MyApp",
	},
]
```

### 5.2 listProfiles logic

- Profiles are loaded from `profiles.json` at runtime (working directory first, or `DEPLOY_PROFILES_PATH` if provided). If every candidate file is missing, invalid (not an array), or empty, the module throws `CONFIG_PROFILE_FILE_NOT_FOUND` with the message `"profiles.json is missing, invalid, or empty; expected at least one deploy profile"`.
- After validation, `listProfiles()` returns the profile names.

### 5.3 resolveProfile logic

Steps:

1. Lookup profile → else throw `CONFIG_PROFILE_NOT_FOUND`
2. Apply defaults:
    - `buildDir = profile.buildDir ?? ".output"`
    - `pm2RestartMode = profile.pm2RestartMode ?? "startOrReload"`
3. Validate required fields:
    - Once a profile name is found, all required fields (`sshConnectionString`, `remoteDir`, `env`, `pm2AppName`) are validated via a central table (`REQUIRED_PROFILE_STRING_FIELDS`).
    - Required fields must be non-empty strings after trimming; missing/empty values throw `CONFIG_PROFILE_INVALID`.
    - Profile names must be unique; enforce uniqueness once at module load time and fail fast if duplicates are found.
    - Optional string fields, if provided, must be non-empty after trimming; otherwise defaults apply.
4. Return resolved config.

Example return:

```ts
return {
	name: profile.name,
	sshConnectionString: profile.sshConnectionString,
	remoteDir: profile.remoteDir,
	buildDir,
	env: profile.env,
	pm2AppName: profile.pm2AppName,
	pm2RestartMode,
}
```

## 6. Error Model

### 6.1 configError helper

```ts
function configError(code: TConfigErrorCode, message: string): Error {
	const err = new Error(message)
	err.cause = code
	return err
}
```

### 6.2 Error cases

- profiles.json missing, invalid (not an array), or empty → `CONFIG_PROFILE_FILE_NOT_FOUND` (`profiles.json is missing, invalid, or empty; expected at least one deploy profile`)
- Requested profile name not found in the validated list → `CONFIG_PROFILE_NOT_FOUND`
- Duplicate profile names detected at load → `CONFIG_DUPLICATE_PROFILE`
- Missing/empty required profile fields (sshConnectionString, remoteDir, env, pm2AppName) → `CONFIG_PROFILE_INVALID`
- Invalid pm2RestartMode → `CONFIG_INVALID_RESTART_MODE`

## 7. Interaction with main.ts

- main.ts is responsible for selecting profile.
- main.ts applies CLI overrides.
- main.ts enforces production-safety rules.
- If `profiles.json` is missing, invalid, or empty, config throws `CONFIG_PROFILE_FILE_NOT_FOUND`; main.ts treats this as fatal (logged via `logFatalError`, exit code 1).

## 8. Future Extensions

- Add richer config sections.
- Add env-var overrides later.
