# Copilot Instructions for @dodefey/deploy

Goal: a gunshi-based CLI that deploys Nuxt apps via a fixed pipeline (tests → build → rsync sync → PM2 restart → churn report). Keep behavior and error codes stable.

Key entrypoints

- `src/cli.ts`: defines `deploy` command and orchestrates phases; respects flags (--profile required; overrides for ssh/dirs/env/app/restartMode; toggles skipTests/skipBuild/dryRun/verbose/churnOnly). Fatal phases: config, tests, build, sync, churn-only. PM2 and churn during full deploy are non-fatal (log only).
- Profiles: `profiles.json` in CWD or `DEPLOY_PROFILES_PATH`; fields name, sshConnectionString, remoteDir, env, pm2AppName, required buildCommand, required buildArgs, optional buildDir (default .output), pm2RestartMode (default startOrReload).

Modules and contracts

- Build: `src/build.ts` `runBuild(command, options)` spawns caller-supplied command/args (no defaults in module); outputMode inherit|silent|callbacks; errors BUILD_COMMAND_NOT_FOUND/BUILD_FAILED/BUILD_INTERRUPTED via Error.cause.
- Tests: `src/test.ts` `runTests()` default `npx vitest run`; same outputMode pattern; errors TEST_COMMAND_NOT_FOUND/TEST_FAILED/TEST_INTERRUPTED.
- Sync: `src/syncBuild.ts` rsync local `.output` to `${remoteDir}/.output`; validates local dir; dryRun skips remote mkdir and uses rsync --dry-run; errors SYNC_NO_LOCAL_OUTPUT_DIR/SYNC_SSH_FAILED/SYNC_RSYNC_FAILED.
- PM2: `src/pm2.ts` uploads `ecosystem.config.js` if changed, then startOrReload or reboot (delete+start), verifies via `pm2 jlist` with retries; errors include PM2_SSH_FAILED/PM2_CONFIG_COMPARE_FAILED/PM2_CONFIG_UPLOAD_FAILED/PM2_COMMAND_FAILED/PM2_STATUS_QUERY_FAILED/PM2_HEALTHCHECK_FAILED/PM2_APP_NAME_NOT_FOUND.
- Churn: `src/churn.ts` builds local manifest from `buildDir/public/_nuxt`, compares to remote `${remoteDir}/.deploy/client-manifests/_nuxt-manifest.sha`, uploads unless dryRun; errors CHURN_NO_CLIENT_DIR/CHURN_REMOTE_MANIFEST_FETCH_FAILED/CHURN_REMOTE_MANIFEST_UPLOAD_FAILED/CHURN_COMPUTE_FAILED. Formatting in `src/churnFormat.ts` (3-line summary, 1-decimal percentages, KB/MB).
- Logging: `src/deployLogging.ts` centralizes logging and formatting; use it instead of console; exposes logDeployStart/logPhaseStart/logFatalError/logNonFatalError etc.

Output handling pattern

- Shared outputMode contract across build/sync/PM2/tests: inherit streams, silent ignores, callbacks split lines to handlers. Respect callbacks when outputMode === "callbacks".

Typical workflows

- Install/build: `npm install`; `npm run build` (tsc to dist/). CLI bin: `dist/cli.js` or `npx @dodefey/deploy ...`.
- Tests: `npm test` (vitest). Lint: `npm run lint`.
- Deploy example: `node dist/cli.js deploy -p prod --sshConnectionString user@host --remoteDir /var/www/app --pm2RestartMode startOrReload`.

Conventions and guardrails

- Preserve typed error codes via Error.cause; do not change without spec alignment.
- Keep fatal vs non-fatal phase semantics intact; churn-only failures are fatal.
- Do not emit console logs from modules; logging flows through deployLogging; modules remain pure/side-effect-limited.
- Keep manifests outside rsync tree: remote manifests live in `.deploy/client-manifests/` to survive sync deletes.
- Default paths: local buildDir `.output`; client assets under `public/_nuxt`.

When modifying behavior

- Update specs in `docs/specs/*` and README if semantics change.
- If adding flags or error codes, thread them through cli.ts, logging, and tests consistently.
