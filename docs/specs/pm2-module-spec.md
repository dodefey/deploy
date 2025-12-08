# PM2 Module Spec

## 1. Purpose

This module is responsible for **applying the PM2 ecosystem configuration and ensuring the app is healthy** on a remote server.

It is strictly:

> “Make the remote ecosystem.config.js match local, restart the app in a controlled way, verify that PM2 reports the app as online, and throw a typed error if anything goes wrong.”

It does **not**:

- handle dry runs,
- manage SSH configuration globally,
- do HTTP health checks,
- support a wide variety of PM2 subcommands.

It focuses on the **core deploy path** only.

---

## 2. Public API

### 2.1. Types

#### 2.1.1 TPM2Options

```ts
export interface TPM2Options {
	sshConnectionString: string
	// SSH target, e.g. "user@host".

	remoteDir: string
	// Remote base directory for the app, e.g. "/var/www/app".
	// Remote ecosystem path = `${remoteDir}/ecosystem.config.js`

	appName: string
	// PM2 process name, e.g. "MyApp".

	localEcosystemPath?: string
	// Optional path to local ecosystem.config.js.
	// Default: path.join(process.cwd(), "ecosystem.config.js")

	env?: string
	// PM2 environment (default "production")

	restartMode?: "startOrReload" | "reboot"
	// startOrReload → pm2 startOrReload ecosystem.config.js --env <env>
	// reboot        → pm2 delete <appName>; pm2 start ecosystem.config.js --env <env>

	outputMode?: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}
```

---

#### 2.1.2 TPM2Result

```ts
export interface TPM2Result {
	configChanged: boolean
	instanceCount: number
}
```

---

#### 2.1.3 TPM2ErrorCode

```ts
export type TPM2ErrorCode =
	| "PM2_SSH_FAILED"
	| "PM2_CONFIG_COMPARE_FAILED"
	| "PM2_CONFIG_UPLOAD_FAILED"
	| "PM2_COMMAND_FAILED"
	| "PM2_STATUS_QUERY_FAILED"
	| "PM2_HEALTHCHECK_FAILED"
```

---

## 3. Error model

- Always throw native Error objects on failure.
- Use `err.cause` to store TPM2ErrorCode.
- Success returns imply success; no `success` field.

---

## 4. Behavior

### 4.1 Inputs resolution

- Resolve local path.
- Remote path = `${remoteDir}/ecosystem.config.js`
- env defaults to `"production"`
- restartMode defaults to `"startOrReload"`
- Logging behavior matches build.ts
- SSH transport: uses the shared deploy SSH defaults driven by `sshConnectionString` (keys/ssh_config). If a shared SSH helper is introduced, this module should consume it; no module-specific SSH config is defined here.

### 4.2 Step 1: Compare configs

- Read local & remote config.
- Strict, literal string comparison (no normalization).
- If the remote config is missing, treat it as a difference and plan to upload.
- If the remote read runs but fails (permissions/non-zero exit), throw PM2_CONFIG_COMPARE_FAILED.
- If the SSH transport itself fails, throw PM2_SSH_FAILED.

### 4.3 Step 2: Upload if needed

- Upload only when content differs or remote missing.
- Throw PM2_CONFIG_UPLOAD_FAILED on failure.

### 4.4 Step 3: PM2 restart

- startOrReload → pm2 startOrReload ecosystem.config.js --env <env>
- reboot → delete + start (ignore a missing app when deleting)
- Missing app is not an error in either mode:
    - startOrReload starts it if absent
    - delete may fail if it is absent; tolerate and continue to start
- Throw PM2_COMMAND_FAILED on any PM2 command failure (non-zero exit)

### 4.5 Step 4: Health check (pm2 jlist)

- Run `pm2 jlist`
- Filter processes by appName
- Count online instances
- Retry 3 total attempts with ~1s delay between attempts
- Success if at least one matching process is online
- If still zero online after retries → throw PM2_HEALTHCHECK_FAILED
- The PM2_HEALTHCHECK_FAILED error message may include a compact, human-readable summary of statuses
  for the app’s processes (e.g., pm_id, status, restart counts). This summary is for debugging only
  and is not a stable machine-parseable API.

---

## 5 Logging

- Controlled via outputMode + callbacks exactly like build.ts.
- Module itself never logs directly.

---

## 6 Dry run

- No dry-run inside this module.
- Caller simply chooses not to invoke it for dry-run deploys.

---

## 7 Non-goals

- No HTTP checks
- No arbitrary PM2 command API
- No multi-app operations
- No success flags

---

## 8 Summary

A small, strict module that:

1. Syncs ecosystem.config.js
2. Restarts the app via reload or reboot
3. Verifies app is online via pm2 jlist
4. Returns minimal success info
5. Throws typed errors for anything else
