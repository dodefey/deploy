# Churn Module – Functional Specification

## 1. Purpose

The churn module measures client-bundle cache impact for returning users and now supports two output levels:

- `computeClientChurn`: legacy core metrics only.
- `computeClientChurnReport`: canonical report envelope with core metrics plus hash-based diagnostics when available.

Default deploy behavior remains legacy-compatible unless diagnostics/report output is explicitly requested by CLI/config.

---

## 2. Manifest Inputs and Locations

All churn analysis starts from the local client directory:

```txt
buildDir/public/_nuxt
```

Remote manifests live outside rsync-managed output:

- Legacy manifest: `remoteDir/.deploy/manifest`
- Rich manifest v2: `remoteDir/.deploy/manifest.v2.json`

Keeping them under `.deploy/` ensures persistence across deploys and avoids deletion by bundle sync operations.

---

## 3. Legacy Manifest (`manifest`)

Legacy manifest lines use:

```txt
<size>  ./relative/path/to/asset.js
```

Properties:

- File identity is path.
- Size is included for byte impact calculations.
- Entries are sorted lexicographically.
- File ends with `\n` when non-empty.

This format powers stable, existing `TChurnMetrics` behavior.

---

## 4. Manifest v2 (`manifest.v2.json`)

Manifest v2 is a JSON payload with schema/version metadata and per-file records:

- `path`
- `size`
- `sha256`
- `assetType` (extension-based classifier)
- `ownerGroup` (heuristic group inference, e.g. vendor/layout/page/component/unknown)

Schema and parsing are defined in `src/churnSchema.ts` and are major-version compatible for forward evolution.

---

## 5. Core Metrics Model

Core metrics remain unchanged and are still derived from path+size comparisons:

- File totals and transitions: old/new/stable/changed/added/removed
- Byte totals and transitions: old/new/stable/changed/added/removed
- Percentages:
    - file download impact / cache reuse
    - byte download impact / cache reuse

These core metrics are the comparability anchor (`metricSetVersion = "core-1"` in reports).

---

## 6. Hash-Aware Diff Categories (v2)

When both old and new manifest v2 are available, the module computes:

- `reused_exact`: same path, same hash
- `changed_same_path`: same path, different hash
- `renamed_same_hash`: different path, same hash
- `new_content`: new path with no hash match in removed set
- `removed`: old path removed with no rename/hash match

These categories provide root-cause diagnostics beyond aggregate churn.

---

## 7. Public APIs

### 7.1 `computeClientChurn(opts)`

Behavior:

1. Build local legacy manifest.
2. Load remote legacy manifest (missing means no baseline).
3. Compute `TChurnMetrics`.
4. Upload legacy manifest unless `dryRun`.

### 7.2 `computeClientChurnReport(opts)`

Behavior:

1. Build local legacy manifest and local manifest v2.
2. Load remote legacy manifest and remote manifest v2.
3. Compute core metrics from legacy manifests.
4. If remote v2 exists and parses, compute hash-aware diagnostics.
5. Build `TChurnReportV1` envelope.
6. Upload legacy manifest and v2 manifest unless `dryRun`.

If remote v2 is missing or invalid, report is still returned with core metrics and quality warnings explaining diagnostics unavailability.

---

## 8. Canonical Report (`TChurnReportV1`)

Report includes:

- Identity/versioning: `schema`, `schemaVersion`, `metricSetVersion`, `reportId`, `generatedAt`
- Run metadata: producer, profile, mode, dry-run
- Baseline metadata: availability/kind/distance
- Capability metadata (hash diff availability and classifier versions)
- `core` metrics (same semantics as legacy output)
- Optional `diagnostics` (category totals, avoidable rename noise)
- `quality` metadata (comparability class + warnings)

Comparability rule of thumb:

- Always compare `core` metrics for stable trend continuity.
- Use `quality.comparableClass` to segment analyses when diagnostics capability differs.

---

## 9. Error Model

Churn errors use `.cause`:

- `CHURN_REMOTE_MANIFEST_FETCH_FAILED`
- `CHURN_REMOTE_MANIFEST_UPLOAD_FAILED`
- `CHURN_COMPUTE_FAILED`
- `CHURN_NO_CLIENT_DIR`

`computeClientChurnReport` preserves this model and adds diagnostics warnings in-report instead of introducing new fatal codes for missing/invalid v2 baselines.

---

## 10. Output Contract

The churn module itself remains a library (no direct console I/O):

- Legacy CLI summary still consumes `TChurnMetrics`.
- Enhanced diagnostics text/JSON formatting is handled by CLI formatting helpers.

This preserves existing deploy output behavior by default while allowing opt-in diagnostic detail.

Rollout and migration guidance for operational adoption is documented in:

- `docs/specs/churn-rollout.md`
