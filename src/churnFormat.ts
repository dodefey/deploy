import type { TChurnMetrics } from "./churn.ts"

export interface TChurnDisplayOptions {
	dryRun?: boolean
}

export function formatChurnMetrics(
	metrics: TChurnMetrics,
	options?: TChurnDisplayOptions,
): string {
	const header = buildHeader(metrics, options)
	const filesLine = buildFilesLine(metrics)
	const bytesLine = buildBytesLine(metrics)
	return [header, filesLine, bytesLine].join("\n")
}

/** @internal Exported to support targeted unit tests. */
export function buildHeader(
	metrics: TChurnMetrics,
	options?: TChurnDisplayOptions,
): string {
	const hasBaseline = metrics.totalOldFiles > 0 || metrics.totalOldBytes > 0
	const isDryRun = options?.dryRun === true

	if (!hasBaseline && isDryRun) {
		return "Client cache impact (no previous baseline, dry run; baseline not updated)"
	}
	if (!hasBaseline) {
		return "Client cache impact (no previous baseline)"
	}
	if (isDryRun) {
		return "Client cache impact (dry run; baseline not updated)"
	}
	return "Client cache impact"
}

function buildFilesLine(metrics: TChurnMetrics): string {
	const download = formatPercent(metrics.downloadImpactFilesPercent)
	const reuse = formatPercent(metrics.cacheReuseFilesPercent)
	const details = `${String(metrics.changedFiles)} changed, ${String(metrics.addedFiles)} added, ${String(metrics.removedFiles)} removed; ${String(metrics.totalOldFiles)} -> ${String(metrics.totalNewFiles)} files`
	return `  Files: ${download}% new/changed, ${reuse}% reused (${details})`
}

function buildBytesLine(metrics: TChurnMetrics): string {
	const download = formatPercent(metrics.downloadImpactBytesPercent)
	const reuse = formatPercent(metrics.cacheReuseBytesPercent)
	const details = `${formatBytes(metrics.changedBytes)} changed, ${formatBytes(
		metrics.addedBytes,
	)} added, ${formatBytes(metrics.removedBytes)} removed; ${formatBytes(
		metrics.totalOldBytes,
	)} -> ${formatBytes(metrics.totalNewBytes)}`
	return `  Bytes: ${download}% new/changed, ${reuse}% reused (${details})`
}

/** @internal Exported to support targeted unit tests. */
export function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10
	return rounded.toFixed(1)
}

/** @internal Exported to support targeted unit tests. */
export function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0.0 KB"
	const kb = bytes / 1024
	if (kb < 1024) {
		return `${kb.toFixed(1)} KB`
	}
	const mb = kb / 1024
	return `${mb.toFixed(1)} MB`
}
