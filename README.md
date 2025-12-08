# @dodefey/deploy

A small gunshi-based CLI that deploys a Nuxt build managed by PM2. It runs tests, builds, syncs the client bundle to a remote host via rsync, restarts PM2, and reports client churn (cache reuse vs download impact) so you know the user-facing cost of a deploy.

## Features
- Single command deploy pipeline: tests → build → rsync sync → PM2 restart → churn report.
- Profile-driven config (`profiles.json`) with per-environment SSH, paths, PM2 app name, and restart mode.
- Typed error codes across build, sync, PM2, config, and churn for predictable handling.
- Flexible output modes (`inherit`, `silent`, `callbacks`) for build/rsync/PM2 stages.
- Dry-run mode: compute churn without modifying the server.

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
Profiles live in `src/profiles.json` and are loaded at runtime. Each profile sets connection and PM2 details.

```json
[
  {
    "name": "prod",
    "sshConnectionString": "user@example.com",
    "remoteDir": "/var/www/app",
    "env": "production",
    "pm2AppName": "my-app",
    "buildDir": ".output",                 // optional, defaults to .output
    "pm2RestartMode": "startOrReload"       // optional, defaults to startOrReload
  }
]
```

Validation rules:
- Missing file / invalid JSON / empty array → `CONFIG_PROFILE_FILE_NOT_FOUND`.
- Unknown profile name → `CONFIG_PROFILE_NOT_FOUND`.
- Duplicate names → `CONFIG_DUPLICATE_PROFILE`.
- Empty required fields → `CONFIG_PROFILE_INVALID`.
- Invalid restart mode → `CONFIG_INVALID_RESTART_MODE`.

## CLI Usage
Main command: `deploy`

Flags (from `src/cli.ts`):
- `--profile, -p <name>` (required) Deploy profile to use.
- `--sshConnectionString, -s <ssh>` Override SSH connection string.
- `--remoteDir, -d <path>` Override remote app dir.
- `--buildDir, -b <path>` Override local build output dir.
- `--env, -e <name>` PM2 env.
- `--pm2AppName <name>` PM2 app name override.
- `--pm2RestartMode <startOrReload|reboot>` PM2 restart mode override.
- `--skipTests, -T` Skip vitest before deploy.
- `--skipBuild, -k` Skip Nuxt build; reuse existing output.
- `--dryRun, -n` Churn only: no sync, no PM2.
- `--verbose, -V` Inherit stdout/stderr from build/rsync/pm2.
- `--churnOnly, -c` Compute churn without build/sync/pm2.

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
2. **Tests**: `vitest` unless `--skipTests`.
3. **Build**: Run Nuxt build (via `runNuxtBuild`); stdout mode per `--verbose`.
4. **Sync**: `rsync` local `.output` to `${remoteDir}/.output` (or override), honors `--dryRun`.
5. **PM2**: `pm2 startOrReload` (or `reboot`) app in `remoteDir`; reports instance count.
6. **Churn**: Compute client bundle churn vs previous manifest stored at `${remoteDir}/.deploy/client-manifests/_nuxt-manifest.sha`; uploads new manifest unless `--dryRun`.

## Scripts
- `npm test` → vitest
- `npm run lint` → eslint
- `npm run build` → tsc to `dist/`

## Output Modes
`outputMode` is one of `inherit` (stream to terminal), `silent`, or `callbacks` (line handlers) and is used by build, sync, and PM2 modules.

## Error Codes (selected)
- Build: `BUILD_COMMAND_NOT_FOUND`, `BUILD_FAILED`
- Sync: `SYNC_NO_LOCAL_OUTPUT_DIR`, `SYNC_SSH_FAILED`, `SYNC_RSYNC_FAILED`
- PM2: `PM2_SSH_FAILED`, `PM2_COMMAND_FAILED`, `PM2_STATUS_QUERY_FAILED`, `PM2_APP_NAME_NOT_FOUND`
- Config: `CONFIG_PROFILE_FILE_NOT_FOUND`, `CONFIG_PROFILE_NOT_FOUND`, `CONFIG_PROFILE_INVALID`, `CONFIG_INVALID_RESTART_MODE`
- Churn: baseline load/parse failures, fetch failures

## Troubleshooting
- **No profile found**: ensure `src/profiles.json` exists and has at least one profile with unique names.
- **PM2 app missing**: check `pm2AppName` matches the ecosystem config on the server.
- **rsync errors**: verify SSH connectivity and remote write permissions to `${remoteDir}/.output`.
- **Churn baseline missing**: first deploy will store a baseline manifest; subsequent runs compare against it.

## License
MIT
