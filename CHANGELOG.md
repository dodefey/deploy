# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Initial entry.

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
