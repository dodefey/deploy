# Churn Diagnostics Rollout and Migration Checklist

## 1. Purpose

This document defines how to roll out enhanced churn diagnostics safely while preserving continuity with existing churn monitoring.

Primary goals:

- Keep default deploy behavior stable unless diagnostics/report output is explicitly requested.
- Preserve trend comparability for legacy dashboards and historical analyses.
- Capture richer churn data for deeper root-cause analysis.

---

## 2. Data Continuity Contract

Comparability must follow these rules:

- Use report `core` metrics as the canonical continuity layer.
- Treat `metricSetVersion` as the semantic contract for trend comparisons.
- Segment analyses by `quality.comparableClass` when capability differs (`core-1` vs `core-1+hash-v1`).
- Never mix diagnostics-only fields into core trend lines without class/version guards.

Required invariant:

- Legacy summary output must remain derivable from report `core` values with no semantic drift.

---

## 3. Migration Scope

In scope:

- Opt-in diagnostics rendering (`off|compact|full|json`).
- Optional report export (`stdout` or file path).
- Manifest v2 baseline creation and reuse.

Out of scope (for this rollout):

- Hard fail budgets/threshold enforcement.
- Long-term history storage service design.
- Cross-repository standardization of owner-group rules.

---

## 4. Phased Rollout

### Phase 0: Baseline Compatibility (completed)

- Ship report schema + parsing + core mapping.
- Keep default CLI behavior on legacy churn path.
- Verify backward-compatible summary output.

Acceptance checks:

- `--churnDiagnostics off` with no report output uses legacy compute path.
- Existing churn summary wording and metric semantics remain unchanged.

### Phase 1: Opt-in Diagnostics Collection (completed)

- Enable report path when diagnostics mode is not `off` or report output is requested.
- Allow developers to export machine-readable reports for analysis.

Acceptance checks:

- `--churnDiagnostics full` produces diagnostics text and core summary.
- `--churnReportOut stdout|<path>` emits valid JSON report payload.
- Missing v2 baseline produces warning-only diagnostics degradation, not fatal failure.

### Phase 2: Team Adoption (next)

- Add CI or deploy job step to persist report JSON artifacts.
- Establish lightweight analysis workflow by profile/environment.

Acceptance checks:

- Reports are retained per deploy run with timestamp/profile metadata.
- Analysts can compare core metrics across historical windows using `metricSetVersion`.
- Diagnostics comparisons are filtered by `comparableClass`.

### Phase 3: Advanced Analysis (future)

- Expand diagnostics payload (attribution, top offenders, recommendations) as needed.
- Introduce history/trend tooling built on stored reports.

Acceptance checks:

- New fields are additive and do not break old report consumers.
- Comparisons against earlier `schemaVersion` remain valid for `core`.

---

## 5. Operational Checklist

Per environment:

1. Confirm deploy runner has write access to `${remoteDir}/.deploy/`.
2. Confirm first enhanced run creates `${remoteDir}/.deploy/manifest.v2.json`.
3. Confirm subsequent enhanced runs report baseline availability and no schema parse warning.
4. Confirm report artifacts are collected when `--churnReportOut` is enabled.
5. Confirm dashboards/queries use only `core` fields for long-range trend continuity.

---

## 6. Rollback Strategy

If enhanced diagnostics cause operational issues:

1. Set diagnostics mode to `off` (config or CLI).
2. Disable report artifact export.
3. Continue using legacy summary path without data model migration risk.

No rollback data loss risk for core metrics:

- Legacy churn flow remains supported.
- Existing `manifest` baseline is unaffected by v2 diagnostics adoption.

---

## 7. Future Evolution Rules

For any report/schema evolution:

- Keep additive changes backward-compatible within major version.
- Bump major version only for breaking shape/semantic changes.
- Maintain `core` continuity or clearly version-gate comparability.
- Document migration notes in this file and `docs/specs/churn.md`.
