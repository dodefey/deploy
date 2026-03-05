import type { TChurnReportV1 } from "./churnSchema.js"
import { formatBytes, formatPercent } from "./churnFormat.js"

export type TChurnDiagnosticsOutputMode = "compact" | "full" | "json"

export interface TChurnDiagnosticsFormatOptions {
	mode?: TChurnDiagnosticsOutputMode
	topN?: number
}

export function formatChurnReportDiagnostics(
	report: TChurnReportV1,
	options?: TChurnDiagnosticsFormatOptions,
): string {
	const mode = options?.mode ?? "compact"

	if (mode === "json") {
		return JSON.stringify(report, null, 2)
	}

	const diagnostics = report.diagnostics
	const warnings = report.quality.warnings

	if (!diagnostics) {
		const reason =
			warnings[0] ??
			"Enhanced diagnostics unavailable: no diagnostics payload in report."
		return ["Churn diagnostics", `  ${reason}`].join("\n")
	}

	if (mode === "compact") {
		return buildCompactDiagnostics(report)
	}

	return buildFullDiagnostics(report, options?.topN)
}

function buildCompactDiagnostics(report: TChurnReportV1): string {
	const diagnostics = report.diagnostics
	if (!diagnostics) {
		return "Churn diagnostics\n  No diagnostics available."
	}

	const categories = diagnostics.categories
	const lines = [
		"Churn diagnostics (compact)",
		`  reused_exact: ${formatCategory(categories.reused_exact)}`,
		`  changed_same_path: ${formatCategory(categories.changed_same_path)}`,
		`  renamed_same_hash: ${formatCategory(categories.renamed_same_hash)}`,
		`  new_content: ${formatCategory(categories.new_content)}`,
		`  removed: ${formatCategory(categories.removed)}`,
	]

	if (diagnostics.avoidableChurn) {
		lines.push(
			`  avoidable rename noise: ${formatBytes(
				diagnostics.avoidableChurn.renameNoiseBytes,
			)} (${formatPercent(
				diagnostics.avoidableChurn.renameNoisePercentOfDownloadBytes,
			)}% of download bytes)`,
		)
	}

	if (report.quality.warnings.length > 0) {
		lines.push(`  warning: ${report.quality.warnings[0]}`)
	}

	return lines.join("\n")
}

function buildFullDiagnostics(report: TChurnReportV1, topN?: number): string {
	const diagnostics = report.diagnostics
	if (!diagnostics) {
		return "Churn diagnostics (full)\n  No diagnostics available."
	}

	const lines = [
		"Churn diagnostics (full)",
		"  Categories:",
		`  - reused_exact: ${formatCategory(diagnostics.categories.reused_exact)}`,
		`  - changed_same_path: ${formatCategory(
			diagnostics.categories.changed_same_path,
		)}`,
		`  - renamed_same_hash: ${formatCategory(
			diagnostics.categories.renamed_same_hash,
		)}`,
		`  - new_content: ${formatCategory(diagnostics.categories.new_content)}`,
		`  - removed: ${formatCategory(diagnostics.categories.removed)}`,
	]

	if (diagnostics.avoidableChurn) {
		lines.push(
			`  Avoidable churn: ${formatBytes(
				diagnostics.avoidableChurn.renameNoiseBytes,
			)} rename noise (${formatPercent(
				diagnostics.avoidableChurn.renameNoisePercentOfDownloadBytes,
			)}% of download bytes)`,
		)
	}

	if (diagnostics.topOffenders) {
		lines.push("  Top offenders:")
		lines.push(
			...formatOffenderGroup(
				"new_content",
				diagnostics.topOffenders.newContentByBytes,
				topN,
			),
		)
		lines.push(
			...formatOffenderGroup(
				"changed_same_path",
				diagnostics.topOffenders.changedSamePathByBytes,
				topN,
			),
		)
		lines.push(
			...formatOffenderGroup(
				"renamed_same_hash",
				diagnostics.topOffenders.renamedSameHashByBytes,
				topN,
			),
		)
	}

	if (diagnostics.attribution) {
		lines.push(
			...formatAttributionGroup(
				"asset type",
				diagnostics.attribution.byAssetType,
			),
		)
		lines.push(
			...formatAttributionGroup(
				"owner group",
				diagnostics.attribution.byOwnerGroup,
			),
		)
		if (diagnostics.attribution.unknownOwnerBytes !== undefined) {
			lines.push(
				`  Unknown owner bytes: ${formatBytes(
					diagnostics.attribution.unknownOwnerBytes,
				)}`,
			)
		}
	}

	if (
		diagnostics.recommendations &&
		Array.isArray(diagnostics.recommendations) &&
		diagnostics.recommendations.length > 0
	) {
		lines.push("  Recommendations:")
		for (const recommendation of diagnostics.recommendations) {
			lines.push(`  - ${recommendation}`)
		}
	}

	if (report.quality.warnings.length > 0) {
		lines.push("  Warnings:")
		for (const warning of report.quality.warnings) {
			lines.push(`  - ${warning}`)
		}
	}

	return lines.join("\n")
}

function formatCategory(
	category: { files: number; bytes: number } | undefined,
): string {
	if (!category) return "0 files, 0.0 KB"
	return `${String(category.files)} files, ${formatBytes(category.bytes)}`
}

function formatOffenderGroup(
	label: string,
	offenders:
		| Array<{
				path: string
				bytes: number
				assetType?: string
				ownerGroup?: string
		  }>
		| undefined,
	topN?: number,
): string[] {
	if (!offenders || offenders.length === 0) {
		return [`  - ${label}: none`]
	}
	const limit =
		typeof topN === "number" && Number.isInteger(topN) && topN > 0
			? topN
			: offenders.length
	const limited = offenders.slice(0, limit)
	const lines = [`  - ${label}:`]
	for (const offender of limited) {
		lines.push(`    ${offender.path} (${formatBytes(offender.bytes)})`)
	}
	return lines
}

function formatAttributionGroup(
	label: string,
	buckets: Array<{ key: string; files: number; bytes: number }> | undefined,
): string[] {
	if (!buckets || buckets.length === 0) {
		return []
	}
	const lines = [`  Attribution by ${label}:`]
	for (const bucket of buckets) {
		lines.push(
			`  - ${bucket.key}: ${String(bucket.files)} files, ${formatBytes(
				bucket.bytes,
			)}`,
		)
	}
	return lines
}
