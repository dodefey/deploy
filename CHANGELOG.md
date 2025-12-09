# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Initial entry.

## v0.1.3 - 2025-12-08

- fix: profile loader now searches CWD first, honors `DEPLOY_PROFILES_PATH`, and only falls back to the package path—so installed consumers use their own `profiles.json` instead of `node_modules/@dodefey/deploy/dist`

## v0.1.2 - 2025-12-08

- fix: load `profiles.json` from the consuming project root (with override env + fallback) so installed packages no longer read profiles from their own `dist` directory
