import { describe, expect, it } from "vitest"

import {
	buildChurnReport,
	compareManifests,
	compareManifestsV2,
} from "../src/churn"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
	CHURN_REPORT_METRIC_SET_VERSION,
	CHURN_REPORT_SCHEMA,
	CHURN_REPORT_SCHEMA_VERSION,
	type TChurnManifestV2,
	type TChurnManifestV2File,
} from "../src/churnSchema"

function buildManifest(files: TChurnManifestV2File[]): TChurnManifestV2 {
	return {
		schema: CHURN_MANIFEST_SCHEMA,
		schemaVersion: CHURN_MANIFEST_SCHEMA_VERSION,
		generatedAt: "2026-03-05T16:00:00Z",
		root: "public/_nuxt",
		files,
	}
}

describe("buildChurnReport", () => {
	it("keeps core metrics identical to legacy compareManifests output", () => {
		const metrics = compareManifests(
			["100  ./a.js", "50  ./b.js", ""].join("\n"),
			["100  ./a.js", "80  ./b.js", "30  ./c.js", ""].join("\n"),
		)

		const report = buildChurnReport({
			metrics,
			dryRun: false,
			profileName: "prod",
			runMode: "deploy",
			reportId: "report-core",
			generatedAt: "2026-03-05T16:00:02Z",
			producerVersion: "0.2.0",
		})

		expect(report.schema).toBe(CHURN_REPORT_SCHEMA)
		expect(report.schemaVersion).toBe(CHURN_REPORT_SCHEMA_VERSION)
		expect(report.metricSetVersion).toBe(CHURN_REPORT_METRIC_SET_VERSION)
		expect(report.core).toEqual({
			files: {
				totalOld: metrics.totalOldFiles,
				totalNew: metrics.totalNewFiles,
				stable: metrics.stableFiles,
				changed: metrics.changedFiles,
				added: metrics.addedFiles,
				removed: metrics.removedFiles,
			},
			bytes: {
				totalOld: metrics.totalOldBytes,
				totalNew: metrics.totalNewBytes,
				stable: metrics.stableBytes,
				changed: metrics.changedBytes,
				added: metrics.addedBytes,
				removed: metrics.removedBytes,
			},
			percent: {
				downloadImpactFiles: metrics.downloadImpactFilesPercent,
				cacheReuseFiles: metrics.cacheReuseFilesPercent,
				downloadImpactBytes: metrics.downloadImpactBytesPercent,
				cacheReuseBytes: metrics.cacheReuseBytesPercent,
			},
		})
		expect(report.capabilities.hashDiff).toBe(false)
		expect(report.quality.comparableClass).toBe("core-1")
		expect(report.quality.warnings).toEqual([])
		expect(report.diagnostics).toBeUndefined()
	})

	it("includes diagnostics + quality class when hash diff is available", () => {
		const metrics = compareManifests(
			["100  ./a.js", "200  ./b.js", ""].join("\n"),
			["100  ./a.js", "120  ./renamed-b.js", "300  ./c.js", ""].join(
				"\n",
			),
		)
		const diff = compareManifestsV2(
			buildManifest([
				{
					path: "./a.js",
					size: 100,
					sha256: "h-a",
					assetType: "js",
					ownerGroup: "page",
				},
				{
					path: "./b.js",
					size: 200,
					sha256: "h-b",
					assetType: "js",
					ownerGroup: "vendor",
				},
			]),
			buildManifest([
				{
					path: "./a.js",
					size: 100,
					sha256: "h-a",
					assetType: "js",
					ownerGroup: "page",
				},
				{
					path: "./renamed-b.js",
					size: 120,
					sha256: "h-b",
					assetType: "js",
					ownerGroup: "vendor",
				},
				{
					path: "./c.js",
					size: 300,
					sha256: "h-c",
					assetType: "js",
					ownerGroup: "component",
				},
			]),
		)

		const report = buildChurnReport({
			metrics,
			dryRun: true,
			diagnosticsDiff: diff,
			profileName: "prod",
			runMode: "churnOnly",
			reportId: "report-diff",
			generatedAt: "2026-03-05T16:00:03Z",
		})

		expect(report.capabilities).toEqual({
			hashDiff: true,
			renameDetection: "hash-match-v1",
			assetTyping: "extension-v1",
			ownerGrouping: "heuristic-v1",
		})
		expect(report.quality.comparableClass).toBe("core-1+hash-v1")
		expect(report.diagnostics?.categories).toEqual(diff.categories)
		expect(report.diagnostics?.avoidableChurn?.renameNoiseBytes).toBe(120)
		expect(
			report.diagnostics?.avoidableChurn
				?.renameNoisePercentOfDownloadBytes,
		).toBeCloseTo((120 * 100) / (120 + 300), 6)
	})

	it("records explicit quality warning when diagnostics are unavailable", () => {
		const metrics = compareManifests("", "100  ./a.js\n")
		const report = buildChurnReport({
			metrics,
			dryRun: false,
			diagnosticsWarning:
				"Enhanced diagnostics unavailable: no previous manifest.v2 baseline.",
			reportId: "report-warning",
			generatedAt: "2026-03-05T16:00:04Z",
		})

		expect(report.quality.warnings).toEqual([
			"Enhanced diagnostics unavailable: no previous manifest.v2 baseline.",
		])
		expect(report.quality.comparableClass).toBe("core-1")
		expect(report.diagnostics).toBeUndefined()
		expect(report.baseline.available).toBe(false)
	})
})
