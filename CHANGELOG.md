# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- docs: record a known issue where real deploy/task terminals can lose Vitest's final failure detail block even though the child test process exits with code `1`; note that switching deploy-mode tests from `--reporter=verbose` to `--reporter=default` did not resolve the problem in a real Nuxt/Vitest project.
- change: add generic terminal deploy event publishing with configurable `http-webhook` sinks for `deploy.completed`, `deploy.failed`, and `deploy.degraded`.

## v0.3.1 - 2026-03-23

- change: add generic terminal deploy event publishing with configurable `http-webhook` sinks for `deploy.completed`, `deploy.failed`, and `deploy.degraded`.
- docs: document event sink profile config and clarify that webhook delivery is generic rather than `server-monitor` specific.

## v0.3.0 - 2026-03-20

- change: verbose deploy phases now inherit child stdio directly so terminal output matches the underlying test/build/deploy tools instead of passing through a replay wrapper.
- change: deploy log files now record structured `[deploy-record]` events for tests, builds, and deploy phases, separating machine-readable file logging from human terminal output.
- change: test logging now captures a secondary Vitest JSON report for deploy logs while preserving the normal verbose Vitest terminal reporter.
- change: removed the PTY/interactive spawn transport experiment and its dependency from the package.

## v0.2.0 - 2026-03-05

- breaking change: churn analysis now uses a single canonical manifest/report pipeline with `${remoteDir}/.deploy/manifest.json`; legacy churn paths and `v2` naming were removed.
- docs: clarify churn output flags and defaults (`--churnReportOut` vs `--churnHistoryOut`, including default `.deploy/churn-history.jsonl`)
- change: churn history records now embed the full canonical report payload under `report` for downstream analysis.

## v0.1.5 - 2025-12-09

- change: churn manifest now lives at `${remoteDir}/.deploy/manifest` (no `client-manifests` subfolder) and keeps the filename `manifest`
- change: `npm test` now runs `vitest run` for a single-pass test run

## v0.1.3 - 2025-12-08

- fix: profile loader now searches CWD first, honors `DEPLOY_PROFILES_PATH`, and only falls back to the package path—so installed consumers use their own `profiles.json` instead of `node_modules/@dodefey/deploy/dist`

## v0.1.4 - 2025-12-08

- add test-only helper and unit tests to lock in `profiles.json` search order (CWD first, optional `DEPLOY_PROFILES_PATH`) without touching the filesystem
- document the search order in README and config spec

## v0.1.2 - 2025-12-08

- fix: load `profiles.json` from the consuming project root (with override env + fallback) so installed packages no longer read profiles from their own `dist` directory
