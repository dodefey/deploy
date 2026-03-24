# @dodefey/deploy

A small gunshi-based CLI that deploys a **profile-defined build** managed by PM2. It runs tests, builds, syncs the client bundle to a remote host via rsync, restarts PM2, and reports client churn (cache reuse vs download impact) so you know the user-facing cost of a deploy. (Nuxt remains the common case, but the build command is now profile-configured.)

## Features

- Single command deploy pipeline: tests → build → rsync sync → PM2 restart → churn report.
- Profile-driven config (`profiles.json`) with per-environment SSH, paths, build command/args, PM2 app name, and restart mode.
- Optional profile logging defaults for console verbosity and deploy log files.
- Optional generic deploy event publishing via HTTP webhooks.
- Typed error codes across build, sync, PM2, config, and churn for predictable handling.
- Flexible output modes (`inherit`, `silent`, `callbacks`) for build/rsync/PM2 stages.
- Dry-run mode: run build + churn and perform an rsync `--dry-run`; skip PM2 restart and make no remote writes.
- Optional enhanced churn diagnostics/report/history output for actionable churn analysis.

## Requirements

- Node 20+ (ES2022 target, ESM).
- SSH access to the target host; `rsync` and `pm2` available on the server.
- PM2 ecosystem file on the server (`ecosystem.config.js`) in `remoteDir`.

## Installation

```bash
npm install
npm run build           # produces dist/ for the CLI binary
```

Run locally without install:

```bash
npx @dodefey/deploy --help
```

(After `npm run build`, the `deploy` bin points to `dist/cli.js`.)

## Configuration (profiles.json)

Profiles live in your project root (`./profiles.json`). The CLI looks in the current working directory first; you can point to another file via the `DEPLOY_PROFILES_PATH` environment variable. Each profile sets connection and PM2 details.

```json
[
	{
		"name": "prod",
		"sshConnectionString": "user@example.com",
		"remoteDir": "/var/www/app",
		"env": "production",
		"pm2AppName": "my-app",
		"buildCommand": "npx", // required
		"buildArgs": ["nuxt", "build", "--dotenv", ".env.production"], // required
		"buildDir": ".output", // optional, defaults to .output
		"pm2RestartMode": "startOrReload", // optional, defaults to startOrReload
		"logging": {
			"console": {
				"verboseDefault": true // optional, defaults to false
			},
			"file": {
				"enabled": true, // optional, defaults to false
				"dir": ".deploy/logs", // optional, defaults to .deploy/logs
				"mode": "perRun" // optional: append|perRun (default perRun)
			}
		},
		"events": {
			"gitSha": "abc1234", // optional; included in webhook event payloads when set
			"releaseVersion": "v1.2.3", // optional; included in webhook event payloads when set
			"sinks": [
				{
					"type": "http-webhook",
					"url": "http://127.0.0.1:4000/hooks/deploy",
					"on": ["deploy.completed", "deploy.failed", "deploy.degraded"],
					"timeoutMs": 3000,
					"retries": 1,
					"fatal": false,
					"headers": {
						"x-deploy-source": "deploy"
					}
				}
			]
		},
		"churn": {
			"diagnosticsDefault": "compact", // optional: off|compact|full|json (default off)
			"topN": 5, // optional positive integer (default 5)
			"groupRules": [{ "pattern": "vendor", "group": "vendor" }] // optional
		}
	}
]
```

Validation rules:

- Missing file / invalid JSON / empty array → `CONFIG_PROFILE_FILE_NOT_FOUND`.
- Unknown profile name → `CONFIG_PROFILE_NOT_FOUND`.
- Duplicate names → `CONFIG_DUPLICATE_PROFILE`.
- Empty required fields (including buildCommand/buildArgs) → `CONFIG_PROFILE_INVALID`.
- Invalid logging fields or modes → `CONFIG_PROFILE_INVALID`.
- Invalid event sink fields or event types → `CONFIG_PROFILE_INVALID`.
- Invalid restart mode → `CONFIG_INVALID_RESTART_MODE`.

## CLI Usage

Main command: `deploy`

Flags (from `src/cli.ts`):

- `--profile, -p <name>` (required) Deploy profile from `profiles.json` to use.
- `--sshConnectionString, -s <ssh>` Override SSH connection string.
- `--remoteDir, -d <path>` Override remote app dir.
- `--buildDir, -b <path>` Override local build output dir.
- `--env, -e <name>` PM2 env.
- `--pm2AppName <name>` PM2 app name override.
- `--pm2RestartMode <startOrReload|reboot>` PM2 restart mode override.
- `--skipTests, -T` Skip vitest before deploy.
- `--skipBuild, -k` Skip build; reuse existing output in `buildDir`.
- `--dryRun, -n` Run build + churn; rsync in `--dry-run` mode; skip PM2 restart (no remote writes).
- `--verbose, -V` Surface raw stdout/stderr from tests/build/rsync/pm2.
- `--churnOnly, -c` Compute churn without build/sync/pm2.
- `--churnDiagnostics <off|compact|full|json>` Enable enhanced churn diagnostics output mode.
- `--churnTopN <n>` Limit top offenders shown in diagnostics output.
- `--churnReportOut <stdout|path>` Emit canonical churn report JSON to stdout or a file path.
- `--churnHistoryOut <stdout|off|path>` Append churn history JSONL to stdout or a file path; use `off` to disable. Defaults to `.deploy/churn-history.jsonl`.

Churn output notes:

- `--churnReportOut` writes the full canonical report (`TChurnReportV1`).
- `--churnHistoryOut` appends one JSONL history record per run, including the full canonical report payload under `report` (plus summary fields for quick scans).
- If omitted, history defaults to `.deploy/churn-history.jsonl`.
- Profile `logging.console.verboseDefault` may enable verbose output by default when `--verbose` is not passed.
- Profile `logging.file` writes deploy logs to `deploy.log` (`append`) or `deploy-<profile>-<timestamp>.log` (`perRun`) under the configured directory.
- The deploy log is a separate deploy record: it always includes deploy/phase lifecycle lines, command metadata, typed errors, and phase results. Tests also add a machine-readable Vitest summary with individual test names and outcomes.
- Profile `events.sinks` may publish terminal deploy events to generic HTTP webhook consumers. In v1, supported event types are `deploy.completed`, `deploy.failed`, and `deploy.degraded`.
- Webhook delivery is generic rather than `server-monitor`-specific: the POST body is the deploy event payload itself.
- Profile `events.gitSha` and `events.releaseVersion`, when set, are included in that payload so consumers such as `server-monitor` can attach richer deploy markers.
- If those profile fields are omitted, deploy falls back to generic runtime env vars: `DEPLOY_GIT_SHA` and `DEPLOY_RELEASE_VERSION`.
- Webhook delivery is non-fatal by default; set `fatal: true` only when the webhook must be part of deploy success criteria.
- Quiet mode keeps the terminal phase-oriented; when file logging is enabled, quiet mode may also capture raw child output into the deploy log because there is no competing human terminal stream.

Example:

```bash
node dist/cli.js deploy \
  --profile prod \
  --sshConnectionString user@example.com \
  --remoteDir /var/www/app \
  --pm2AppName my-app \
  --pm2RestartMode startOrReload
```

## Deploy Pipeline (what happens)

1. **Config**: Load profile, apply CLI overrides, validate restart mode.
2. **Tests**: `npx vitest run --reporter=verbose` unless `--skipTests`. When file logging is enabled, deploy also adds a JSON Vitest reporter artifact so the deploy log can enumerate test cases and outcomes without stealing the live terminal stream.
3. **Build**: Run the profile-defined build command (via `runBuild`); verbose mode gives the child process direct terminal control.
4. **Sync**: `rsync` local `.output` to `${remoteDir}/.output` (or override), honors `--dryRun`.
5. **PM2**: `pm2 startOrReload` (or `reboot`) app in `remoteDir`; reports instance count.
6. **Churn**: compute canonical churn report against `${remoteDir}/.deploy/manifest.json`, log churn summary from report core metrics, optionally render diagnostics, optionally write full report output, optionally append churn history JSONL, and upload updated baseline unless `--dryRun`.

## Scripts

- `npm test` → vitest
- `npm run lint` → eslint
- `npm run build` → tsc to `dist/`

## Output Modes

`outputMode` is one of `inherit`, `silent`, or `callbacks` and is used by build, sync, PM2, and tests. In deploy orchestration, verbose mode restores direct human-facing execution with `inherit`, so surfaced commands behave like a normal terminal run. File logging is a separate channel owned by the orchestrator: it records lifecycle lines, command metadata, typed errors, phase summaries, and for tests a machine-readable Vitest report with individual test names and outcomes. Quiet mode may still use callback capture for raw child output because there is no operator-facing terminal stream to preserve.

## Error Codes (selected)

- Build: `BUILD_COMMAND_NOT_FOUND`, `BUILD_FAILED`
- Sync: `SYNC_NO_LOCAL_OUTPUT_DIR`, `SYNC_SSH_FAILED`, `SYNC_RSYNC_FAILED`
- PM2: `PM2_SSH_FAILED`, `PM2_COMMAND_FAILED`, `PM2_STATUS_QUERY_FAILED`, `PM2_APP_NAME_NOT_FOUND`
- Config: `CONFIG_PROFILE_FILE_NOT_FOUND`, `CONFIG_PROFILE_NOT_FOUND`, `CONFIG_PROFILE_INVALID`, `CONFIG_INVALID_RESTART_MODE`
- Churn: baseline load/parse failures, fetch failures

## Troubleshooting

- **No profile found**: ensure `./profiles.json` exists in the directory where you run the CLI (or set `DEPLOY_PROFILES_PATH`) and that it has at least one profile with unique names.
- **PM2 app missing**: check `pm2AppName` matches the ecosystem config on the server.
- **rsync errors**: verify SSH connectivity and remote write permissions to `${remoteDir}/.output`.
- **Churn baseline missing**: first deploy will create `${remoteDir}/.deploy/manifest.json`; subsequent runs compare against it.
- **Vitest exits with code `1`, but the terminal never shows the final failed-test details**: this is a known issue in some real task/integrated-terminal environments. We reproduced it in a Nuxt app using `deploy -p production -n` with Vitest `v4.1.0`: the terminal showed live progress, then deploy logged `Tests error [TEST_FAILED] ... exited with code 1` without the final Vitest failure block. We also tested a deploy-only reporter swap from `--reporter=verbose` to `--reporter=default`, and the real project still dropped the final failure detail block. If this needs investigation again, start from the real project/task environment rather than the local deploy repo repros, and assume the JSON reporter artifact is the only fully reliable source of failed test details that deploy controls today.

## License

MIT
