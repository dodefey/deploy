import { describe, expect, it } from "vitest"

import {
	buildChurnReport,
	compareManifestDiff,
	compareManifestMetrics,
} from "../src/churn"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
	CHURN_REPORT_METRIC_SET_VERSION,
	CHURN_REPORT_SCHEMA,
	CHURN_REPORT_SCHEMA_VERSION,
	type TChurnManifest,
	type TChurnManifestFile,
} from "../src/churnSchema"

function buildManifest(files: TChurnManifestFile[]): TChurnManifest {
	return {
		schema: CHURN_MANIFEST_SCHEMA,
		schemaVersion: CHURN_MANIFEST_SCHEMA_VERSION,
		generatedAt: "2026-03-05T16:00:00Z",
		root: "public/_nuxt",
		files,
	}
}

describe("buildChurnReport", () => {
	it("maps core metrics into the report envelope", () => {
		const oldManifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "a-old",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./b.js",
				size: 50,
				sha256: "b-old",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "a-new",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./b.js",
				size: 80,
				sha256: "b-new",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./c.js",
				size: 30,
				sha256: "c-new",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const metrics = compareManifestMetrics(oldManifest, newManifest)
		const diff = compareManifestDiff(oldManifest, newManifest)

		const report = buildChurnReport({
			metrics,
			diagnosticsDiff: diff,
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
		expect(report.capabilities).toEqual({
			hashDiff: true,
			renameDetection: "hash-match",
			assetTyping: "extension",
			ownerGrouping: "heuristic",
		})
		expect(report.quality.comparableClass).toBe("core-1+hash")
		expect(report.quality.warnings).toEqual([])
	})

	it("includes diagnostics categories and avoidable churn", () => {
		const oldManifest = buildManifest([
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
		])
		const newManifest = buildManifest([
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
		])
		const metrics = compareManifestMetrics(oldManifest, newManifest)
		const diff = compareManifestDiff(oldManifest, newManifest)

		const report = buildChurnReport({
			metrics,
			diagnosticsDiff: diff,
			dryRun: true,
			profileName: "prod",
			runMode: "churnOnly",
			reportId: "report-diff",
			generatedAt: "2026-03-05T16:00:03Z",
		})

		expect(report.diagnostics?.categories).toEqual(diff.categories)
		expect(report.diagnostics?.avoidableChurn?.renameNoiseBytes).toBe(120)
		expect(
			report.diagnostics?.avoidableChurn
				?.renameNoisePercentOfDownloadBytes,
		).toBeCloseTo((120 * 100) / (120 + 300), 6)
		expect(report.diagnostics?.topOffenders?.newContentByBytes).toEqual([
			{
				path: "./c.js",
				bytes: 300,
				assetType: "js",
				ownerGroup: "component",
			},
		])
		expect(
			report.diagnostics?.topOffenders?.renamedSameHashByBytes,
		).toEqual([
			{
				path: "./renamed-b.js",
				bytes: 120,
				assetType: "js",
				ownerGroup: "vendor",
			},
		])
		expect(report.diagnostics?.attribution?.byOwnerGroup).toEqual([
			{ key: "component", files: 1, bytes: 300 },
			{ key: "vendor", files: 1, bytes: 120 },
		])
		expect(report.diagnostics?.recommendations).toContain(
			"High rename churn detected. Stabilize chunk and asset naming to improve client cache reuse.",
		)
	})

	it("sets baseline.available to false when there is no previous manifest", () => {
		const oldManifest = buildManifest([])
		const newManifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "h-a",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const metrics = compareManifestMetrics(oldManifest, newManifest)
		const diff = compareManifestDiff(oldManifest, newManifest)

		const report = buildChurnReport({
			metrics,
			diagnosticsDiff: diff,
			dryRun: false,
			reportId: "report-first-run",
			generatedAt: "2026-03-05T16:00:04Z",
		})

		expect(report.baseline.available).toBe(false)
		expect(report.quality.warnings).toEqual([])
	})

	it("builds deterministic top offenders and attribution ordering", () => {
		const oldManifest = buildManifest([])
		const newManifest = buildManifest([
			{
				path: "./z.js",
				size: 200,
				sha256: "h-z",
				assetType: "js",
				ownerGroup: "beta",
			},
			{
				path: "./a.js",
				size: 200,
				sha256: "h-a",
				assetType: "js",
				ownerGroup: "alpha",
			},
			{
				path: "./mid.js",
				size: 150,
				sha256: "h-mid",
				assetType: "js",
				ownerGroup: "beta",
			},
			{
				path: "./small.css",
				size: 80,
				sha256: "h-small-css",
				assetType: "css",
				ownerGroup: "alpha",
			},
			{
				path: "./tiny.map",
				size: 20,
				sha256: "h-tiny-map",
				assetType: "sourcemap",
				ownerGroup: "alpha",
			},
			{
				path: "./micro.json",
				size: 10,
				sha256: "h-micro-json",
				assetType: "json",
				ownerGroup: "beta",
			},
		])

		const metrics = compareManifestMetrics(oldManifest, newManifest)
		const diff = compareManifestDiff(oldManifest, newManifest)

		const report = buildChurnReport({
			metrics,
			diagnosticsDiff: diff,
			dryRun: false,
			reportId: "report-sorting",
			generatedAt: "2026-03-05T16:00:05Z",
		})

		expect(
			report.diagnostics?.topOffenders?.newContentByBytes?.map(
				(offender) => offender.path,
			),
		).toEqual(["./a.js", "./z.js", "./mid.js", "./small.css", "./tiny.map"])

		expect(report.diagnostics?.attribution?.byOwnerGroup).toEqual([
			{ key: "beta", files: 3, bytes: 360 },
			{ key: "alpha", files: 3, bytes: 300 },
		])
	})

	it("emits recommendations for dominant owner, sourcemaps, and unknown ownership", () => {
		const oldManifest = buildManifest([])
		const newManifest = buildManifest([
			{
				path: "./maps/app.js.map",
				size: 300,
				sha256: "h-map",
				assetType: "sourcemap",
				ownerGroup: "unknown",
			},
			{
				path: "./chunks/app.js",
				size: 100,
				sha256: "h-js",
				assetType: "js",
				ownerGroup: "unknown",
			},
		])

		const metrics = compareManifestMetrics(oldManifest, newManifest)
		const diff = compareManifestDiff(oldManifest, newManifest)

		const report = buildChurnReport({
			metrics,
			diagnosticsDiff: diff,
			dryRun: false,
			reportId: "report-recommendations",
			generatedAt: "2026-03-05T16:00:06Z",
		})

		expect(report.diagnostics?.recommendations).toContain(
			"New content dominates download impact. Focus on code-splitting and reducing fresh bundle bytes.",
		)
		expect(report.diagnostics?.recommendations).toContain(
			'Most churn bytes are in owner group "unknown". Start optimization work there for fastest impact.',
		)
		expect(report.diagnostics?.recommendations).toContain(
			"Sourcemaps contribute significant churn bytes. Consider excluding maps from deploy sync if production debugging allows.",
		)
		expect(report.diagnostics?.recommendations).toContain(
			"A notable share of churn is unowned. Improve owner grouping rules to make diagnostics more actionable.",
		)
	})
})
