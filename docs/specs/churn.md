# Churn Module – Functional Specification

## 1. Purpose

The churn module measures **client-bundle cache impact** for returning users after a deploy.
It answers:

- **How much of the new bundle can be reused from browser cache?**
- **How much must be downloaded again, in files and bytes?**

This expresses the _real-world impact_ of a deploy on repeat visitors.

The comparison is based on **file URLs (paths)** and **file sizes**, matching how browsers actually cache fingerprinted assets.

---

## 2. Manifest Format

Manifests represent all client bundle assets and encode only the necessary data:

```
<size>  ./relative/path/to/asset.js
```

Properties:

- **File identity = URL (path)**  
  Nuxt filenames are already content-hashed, so filenames uniquely identify versions.
- **Size included** for byte-impact analysis.
- **Sorted lexicographically**, newline-separated.
- Always ends with a newline when non-empty.

---

## 3. Manifest Locations

### Local manifest

Generated from:

```
buildDir/public/_nuxt
```

### Remote manifest

Stored at:

```
remoteDir/.deploy/manifest
```

Reasoning:

- Must **persist across deploys**.
- Must **not** live inside `.output`, because rsync wipes that directory.
- Stored in a dedicated deploy metadata directory.

---

## 4. Churn Metrics

Churn is computed with both **file counts** and **byte counts**.

### 4.1 File counts

- `totalOldFiles`
- `totalNewFiles`
- `stableFiles`
- `changedFiles`
- `addedFiles`
- `removedFiles`

### 4.2 Byte counts

- `totalOldBytes`
- `totalNewBytes`
- `stableBytes`
- `changedBytes`
- `addedBytes`
- `removedBytes`

### 4.3 Percentages

#### File-based:

- `downloadImpactFilesPercent = (changedFiles + addedFiles) / totalNewFiles * 100`
- `cacheReuseFilesPercent = stableFiles / totalNewFiles * 100`

#### Byte-based:

- `downloadImpactBytesPercent = (changedBytes + addedBytes) / totalNewBytes * 100`
- `cacheReuseBytesPercent = stableBytes / totalNewBytes * 100`

---

## 5. Comparison Rules

- **added** → path not in old manifest
- **removed** → path not in new manifest
- **stable** → same path, same size
- **changed** → same path, different size

---

## 6. computeClientChurn Behavior

1. Compute local manifest.
2. Load remote manifest (missing = baseline miss).
3. Compare manifests.
4. If `dryRun === false`, upload updated manifest.
5. Return churn metrics.

Dry-run still computes churn but does _not_ upload a manifest.

---

## 7. Error Model

Errors use `.cause` with the following codes:

- `CHURN_REMOTE_MANIFEST_FETCH_FAILED`
- `CHURN_REMOTE_MANIFEST_UPLOAD_FAILED`
- `CHURN_COMPUTE_FAILED`
- `CHURN_NO_CLIENT_DIR` (if thrown, see taxonomy)

Notes:

- If a “no client dir” condition needs to be represented, use `CHURN_NO_CLIENT_DIR` consistently across taxonomy, spec, and implementation.

---

## 8. SSH Behavior

- Uses hardened SSH options.
- Safe quoting for remote paths.
- Uses `test -f` to detect existence.
- Resolves command result **exactly once**.

---

## 9. Module Design Principles

- Pure library (no console I/O).
- Deterministic outputs.
- Clean manifest pipeline.
- Survives rsync wipes.

---

## 10. Output Format

```
Client cache impact
  Files: X.X% need (re)download (...)
  Bytes: X.X% need (re)download (...)
```
