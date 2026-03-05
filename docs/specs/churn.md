# Churn Module – Functional Specification

## 1. Purpose

The churn module computes deploy-to-deploy client cache impact and produces a canonical churn report.

It exposes one compute entrypoint:

- `computeClientChurnReport(opts)`

## 2. Manifest Input and Location

Local source assets are read from:

```txt
buildDir/public/_nuxt
```

Remote baseline path:

- `${remoteDir}/.deploy/manifest.json`

The manifest is kept under `.deploy/` so it is not removed by bundle sync operations.

## 3. Manifest Model

Manifest schema is JSON (`com.dodefey.churn-manifest`, `1.x`) with per-file records:

- `path`
- `size`
- `sha256`
- `assetType`
- `ownerGroup`

Schema parsing and validation are defined in `src/churnSchema.ts`.

## 4. Core Metrics Model

Core metrics are derived from path+size comparisons between previous and current manifests:

- File totals: old/new/stable/changed/added/removed
- Byte totals: old/new/stable/changed/added/removed
- Percentages:
    - download impact / cache reuse by files
    - download impact / cache reuse by bytes

## 5. Diagnostics Categories

Diagnostics are always computed from hash-aware manifest diff:

- `reused_exact`
- `changed_same_path`
- `renamed_same_hash`
- `new_content`
- `removed`

Report diagnostics also include avoidable rename noise totals.

## 6. Public APIs

### 6.1 `computeClientChurnReport(opts)`

Behavior:

1. Build local manifest JSON.
2. Load remote manifest JSON baseline if present.
3. Compute core metrics from previous/current manifests.
4. Compute diagnostics diff categories.
5. Build `TChurnReportV1` payload.
6. Upload updated manifest baseline unless `dryRun`.

If the baseline file is missing, the run proceeds with an empty previous manifest.

## 7. Report Contract (`TChurnReportV1`)

Report includes:

- `schema`, `schemaVersion`, `metricSetVersion`, `reportId`, `generatedAt`
- `producer`, `run`, `baseline`
- `capabilities`
- `core`
- `diagnostics`
- `quality`

Current capability/class values:

- `renameDetection: "hash-match"`
- `assetTyping: "extension"`
- `ownerGrouping: "heuristic"`
- `quality.comparableClass: "core-1+hash"`

## 8. Error Model

Typed churn errors (`Error.cause`):

- `CHURN_NO_CLIENT_DIR`
- `CHURN_REMOTE_MANIFEST_FETCH_FAILED`
- `CHURN_REMOTE_MANIFEST_UPLOAD_FAILED`
- `CHURN_COMPUTE_FAILED`

## 9. Output Contract

`src/churn.ts` performs no direct console logging.

- Human-facing summary formatting: `src/churnFormat.ts`
- Diagnostics formatting: `src/churnDiagnosticsFormat.ts`

## 10. Operational Guidance

### 10.1 Baseline lifecycle

- Remote baseline file is `${remoteDir}/.deploy/manifest.json`.
- First non-dry run creates the baseline.
- Dry-runs do not update baseline data.
- Subsequent runs compare current manifest against the baseline.

### 10.2 Environment checks

Per environment:

1. Confirm deploy runner can read/write `${remoteDir}/.deploy/`.
2. Confirm first non-dry run creates `${remoteDir}/.deploy/manifest.json`.
3. Confirm the next run reports `baseline.available=true`.
4. If `--churnReportOut` is used, confirm artifact retention policy is in place.

### 10.3 Failure handling

- Missing baseline file is treated as empty previous state.
- Invalid/unreadable baseline file fails churn with a typed churn error.
- In full deploy mode, churn failure is non-fatal at orchestrator level.
- In `--churnOnly` mode, churn failure is fatal.

### 10.4 Schema/report evolution

- Keep additive manifest/report changes within current major versions.
- Bump major versions only for breaking shape or semantic changes.
- Keep report core metric semantics stable for trend continuity.
