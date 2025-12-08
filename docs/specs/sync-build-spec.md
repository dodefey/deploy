# syncBuild Module Specification

## 1. Purpose

The `syncBuild` module is responsible for **safely and efficiently synchronizing the local Nuxt production build output** to a remote deployment directory.

- A single build directory (`.output`) is maintained on the server.
- Rsync is used as the sole synchronization mechanism.
- Unchanged files on the server remain untouched.
- Files removed locally are removed remotely (`--delete`).
- No fallback mechanism (e.g., tar streaming) is used.
- A failed sync results in a deterministic, typed error.

The goal is to:

- **Minimize touching unchanged files**, maintaining stable mtimes and preserving accurate churn analysis.
- **Propagate only necessary changes** to the server.
- **Fail loudly** if rsync cannot complete successfully.
- Integrate with the existing build/pm2/churn error & output models.

## 2. API

### 2.1 Function

```ts
export async function syncBuild(options: TSyncBuildOptions): Promise<void>
```

The function resolves successfully (`Promise<void>`) when the sync completes without errors. Any failure results in a thrown `Error` with a typed `cause` code.

## 3. Options

```ts
export interface TSyncBuildOptions {
	sshConnectionString: string // "user@host"
	remoteDir: string // "/var/www/app"
	localOutputDir?: string // default: ".output"
	dryRun?: boolean // if true: rsync --dry-run, no mkdir, no remote changes

	outputMode?: TBuildOutputMode // "inherit" | "silent" | "callbacks"
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}
```

### 3.1 Semantics

- `localOutputDir`
    - Defaults to `.output`.
    - Resolved relative to `process.cwd()` unless absolute.
    - Must exist and must be a directory, otherwise the module throws.

- `remoteDir`
    - The application’s remote root.
    - The module will sync into `${remoteDir}/.output`.

- `dryRun`
    - If `true`:
        - Do **not** create the remote directory.
        - Execute rsync with `--dry-run`.
        - Do not modify the server in any way.
        - Still validate that `localOutputDir` exists.

- `outputMode` and callbacks
    - Behaves exactly like the output model used by `build.ts` and `pm2.ts`.
    - `"inherit"`: module writes rsync output to process stdout/stderr.
    - `"silent"`: nothing printed.
    - `"callbacks"`: output is delivered line-by-line to provided callbacks.

## 4. Behavior

### 4.1 Determine local and remote directories

- Local source: `localOutputDir` (default `.output`).
- Remote target: `${remoteDir}/.output`.

### 4.2 Validate local directory

The module must:

1. Check whether `localOutputDir` exists.
2. Ensure it is a directory.

If not, throw:

```ts
cause: "SYNC_NO_LOCAL_OUTPUT_DIR"
```

with a clear error message.

### 4.3 Ensure remote directory exists (live runs only)

If `dryRun !== true`:

```
ssh host "mkdir -p ${remoteDir}/.output"
```

Any SSH failure results in:

```
cause: "SYNC_SSH_FAILED"
```

### 4.4 Build the rsync command

Flags:

- `-a`
- `-z`
- `--delete`
- `--timeout=60`
- No `--inplace`
- Append `--dry-run` when requested
- Use `-e ssh` (with standard SSH defaults) and shell-quote paths. Include a trailing slash
  on the source to sync contents of the local output dir into `${remoteDir}/.output/`.

### 4.5 Execute rsync

- Single rsync invocation.
- Output wired using `outputMode` model.

### 4.6 Success

- Exit code `0` → return `void`.

### 4.7 Failure

Any non-zero exit or spawn error:

```
cause: "SYNC_RSYNC_FAILED"
```

## 5. Error Model

```ts
export type TSyncBuildErrorCode =
	| "SYNC_NO_LOCAL_OUTPUT_DIR"
	| "SYNC_SSH_FAILED"
	| "SYNC_RSYNC_FAILED"
```

Errors thrown are native `Error` objects:

- `error.message` is human-readable.
- `error.cause` is one of the error codes above.

## 6. Output Behavior

Controlled entirely by:

- `outputMode`
- `onStdoutLine`
- `onStderrLine`

No forced verbosity or progress output.

Dry-run uses rsync's standard `--dry-run` output.

## 7. Summary / Return Value

- The function returns `Promise<void>` on success.
- Errors are typed using `Error.cause`.

## Appendix: Versioned Directory Structure – Future Extension (Not Implemented)

A future version may introduce:

1. Versioned release directories.
2. Atomic symlink swap (`current` → new release).
3. Release retention and cleanup.
