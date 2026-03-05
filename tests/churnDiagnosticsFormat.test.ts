import { describe, expect, it } from "vitest"

import { formatChurnReportDiagnostics } from "../src/churnDiagnosticsFormat"
import {
	CHURN_REPORT_METRIC_SET_VERSION,
	CHURN_REPORT_SCHEMA,
	CHURN_REPORT_SCHEMA_VERSION,
	type TChurnReportV1,
} from "../src/churnSchema"

function baseReport(): TChurnReportV1 {
	return {
		schema: CHURN_REPORT_SCHEMA,
		schemaVersion: CHURN_REPORT_SCHEMA_VERSION,
		metricSetVersion: CHURN_REPORT_METRIC_SET_VERSION,
		reportId: "report-1",
		generatedAt: "2026-03-05T16:00:02Z",
		producer: {
			name: "@dodefey/deploy",
			version: "0.2.0",
		},
		run: {
			profile: "prod",
			mode: "deploy",
			dryRun: false,
		},
		baseline: {
			available: true,
			kind: "previous_deploy",
			distance: 1,
		},
		capabilities: {
			hashDiff: true,
			renameDetection: "hash-match",
			assetTyping: "extension",
			ownerGrouping: "heuristic",
		},
		core: {
			files: {
				totalOld: 10,
				totalNew: 12,
				stable: 5,
				changed: 2,
				added: 3,
				removed: 1,
			},
			bytes: {
				totalOld: 1000,
				totalNew: 1500,
				stable: 500,
				changed: 300,
				added: 700,
				removed: 200,
			},
			percent: {
				downloadImpactFiles: 41.7,
				cacheReuseFiles: 58.3,
				downloadImpactBytes: 66.7,
				cacheReuseBytes: 33.3,
			},
		},
		diagnostics: {
			categories: {
				reused_exact: { files: 5, bytes: 500 },
				changed_same_path: { files: 2, bytes: 300 },
				renamed_same_hash: { files: 2, bytes: 400 },
				new_content: { files: 3, bytes: 700 },
				removed: { files: 1, bytes: 200 },
			},
			avoidableChurn: {
				renameNoiseBytes: 400,
				renameNoisePercentOfDownloadBytes: 28.57,
			},
			topOffenders: {
				newContentByBytes: [
					{ path: "./new.js", bytes: 512000, assetType: "js" },
					{ path: "./new-2.js", bytes: 400000, assetType: "js" },
				],
				changedSamePathByBytes: [
					{ path: "./app.js", bytes: 128000, assetType: "js" },
					{ path: "./app-2.js", bytes: 120000, assetType: "js" },
				],
				renamedSameHashByBytes: [
					{ path: "./renamed.js", bytes: 64000, assetType: "js" },
					{ path: "./renamed-2.js", bytes: 32000, assetType: "js" },
				],
			},
			attribution: {
				byAssetType: [{ key: "js", files: 8, bytes: 1200 }],
				byOwnerGroup: [{ key: "vendor", files: 3, bytes: 900 }],
				unknownOwnerBytes: 100,
			},
			recommendations: ["Investigate filename churn in vendor chunking."],
		},
		quality: {
			comparableClass: "core-1+hash",
			warnings: [],
		},
	}
}

describe("formatChurnReportDiagnostics", () => {
	it("renders compact output by default", () => {
		const output = formatChurnReportDiagnostics(baseReport())
		expect(output).toContain("Churn diagnostics (compact)")
		expect(output).toContain("reused_exact: 5 files")
		expect(output).toContain("changed_same_path: 2 files")
		expect(output).toContain("avoidable rename noise:")
	})

	it("renders full output with top offenders and attribution", () => {
		const output = formatChurnReportDiagnostics(baseReport(), {
			mode: "full",
		})
		expect(output).toContain("Churn diagnostics (full)")
		expect(output).toContain("Top offenders:")
		expect(output).toContain("./new.js")
		expect(output).toContain("Attribution by asset type:")
		expect(output).toContain("Recommendations:")
	})

	it("limits top offenders in full mode when topN is set", () => {
		const output = formatChurnReportDiagnostics(baseReport(), {
			mode: "full",
			topN: 1,
		})

		expect(output).toContain("./new.js")
		expect(output).not.toContain("./new-2.js")
		expect(output).toContain("./app.js")
		expect(output).not.toContain("./app-2.js")
		expect(output).toContain("./renamed.js")
		expect(output).not.toContain("./renamed-2.js")
	})

	it("renders warning message when diagnostics are absent", () => {
		const report = baseReport()
		delete report.diagnostics
		report.quality.warnings = [
			"Diagnostics unavailable: report has no diagnostics payload.",
		]

		const output = formatChurnReportDiagnostics(report, { mode: "compact" })
		expect(output).toContain("Churn diagnostics")
		expect(output).toContain(
			"Diagnostics unavailable: report has no diagnostics payload.",
		)
	})

	it("renders JSON mode as pretty-printed report", () => {
		const report = baseReport()
		const output = formatChurnReportDiagnostics(report, { mode: "json" })
		const parsed = JSON.parse(output) as TChurnReportV1

		expect(parsed.reportId).toBe("report-1")
		expect(parsed.schema).toBe(CHURN_REPORT_SCHEMA)
		expect(output).toContain('\n  "schema"')
	})
})
