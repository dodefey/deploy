import { describe, expect, it } from "vitest"

import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_MAJOR,
	CHURN_MANIFEST_SCHEMA_VERSION,
	CHURN_REPORT_METRIC_SET_VERSION,
	CHURN_REPORT_SCHEMA,
	CHURN_REPORT_SCHEMA_MAJOR,
	CHURN_REPORT_SCHEMA_VERSION,
	parseChurnManifestV2,
	parseChurnManifestV2Json,
	parseChurnReportV1,
	parseChurnReportV1Json,
} from "../src/churnSchema"

describe("churnSchema constants", () => {
	it("exposes stable schema constants", () => {
		expect(CHURN_MANIFEST_SCHEMA).toBe("com.dodefey.churn-manifest")
		expect(CHURN_MANIFEST_SCHEMA_MAJOR).toBe(2)
		expect(CHURN_MANIFEST_SCHEMA_VERSION).toBe("2.0.0")

		expect(CHURN_REPORT_SCHEMA).toBe("com.dodefey.churn-report")
		expect(CHURN_REPORT_SCHEMA_MAJOR).toBe(1)
		expect(CHURN_REPORT_SCHEMA_VERSION).toBe("1.0.0")
		expect(CHURN_REPORT_METRIC_SET_VERSION).toBe("core-1")
	})
})

describe("parseChurnManifestV2", () => {
	it("accepts unknown fields for forward compatibility", () => {
		const manifest = parseChurnManifestV2({
			schema: CHURN_MANIFEST_SCHEMA,
			schemaVersion: "2.1.0",
			generatedAt: "2026-03-05T16:00:00Z",
			root: "public/_nuxt",
			ignoredTopLevel: "ok",
			files: [
				{
					path: "./entry.abc123.js",
					size: 48123,
					sha256: "a".repeat(64),
					assetType: "js",
					ownerGroup: "vendor",
					ignoredNested: 123,
				},
			],
		})

		expect(manifest).toEqual({
			schema: CHURN_MANIFEST_SCHEMA,
			schemaVersion: "2.1.0",
			generatedAt: "2026-03-05T16:00:00Z",
			root: "public/_nuxt",
			files: [
				{
					path: "./entry.abc123.js",
					size: 48123,
					sha256: "a".repeat(64),
					assetType: "js",
					ownerGroup: "vendor",
				},
			],
		})
	})

	it("parses valid JSON content", () => {
		const content = JSON.stringify({
			schema: CHURN_MANIFEST_SCHEMA,
			schemaVersion: CHURN_MANIFEST_SCHEMA_VERSION,
			generatedAt: "2026-03-05T16:00:00Z",
			root: "public/_nuxt",
			files: [],
		})

		const parsed = parseChurnManifestV2Json(content)
		expect(parsed.files).toEqual([])
	})

	it("rejects unsupported major versions", () => {
		expect(() =>
			parseChurnManifestV2({
				schema: CHURN_MANIFEST_SCHEMA,
				schemaVersion: "3.0.0",
				generatedAt: "2026-03-05T16:00:00Z",
				root: "public/_nuxt",
				files: [],
			}),
		).toThrow(/major version 2/)
	})
})

describe("parseChurnReportV1", () => {
	const minimalReport = {
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
			renameDetection: "hash-match-v1",
			assetTyping: "extension-v1",
			ownerGrouping: "heuristic-v1",
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
				totalNew: 1200,
				stable: 500,
				changed: 200,
				added: 500,
				removed: 100,
			},
			percent: {
				downloadImpactFiles: 41.7,
				cacheReuseFiles: 58.3,
				downloadImpactBytes: 58.3,
				cacheReuseBytes: 41.7,
			},
		},
		quality: {
			comparableClass: "core-1+hash-v1",
			warnings: [],
		},
	}

	it("accepts unknown fields for forward compatibility", () => {
		const report = parseChurnReportV1({
			...minimalReport,
			unknownTopLevel: "ignored",
			producer: {
				...minimalReport.producer,
				unknownNested: "ignored",
			},
			capabilities: {
				...minimalReport.capabilities,
				unknownCapability: "ignored",
			},
			quality: {
				...minimalReport.quality,
				unknownQuality: 123,
			},
		})

		expect(report).toEqual(minimalReport)
	})

	it("parses valid JSON content", () => {
		const parsed = parseChurnReportV1Json(JSON.stringify(minimalReport))
		expect(parsed.metricSetVersion).toBe(CHURN_REPORT_METRIC_SET_VERSION)
	})

	it("accepts same-major schema versions", () => {
		const parsed = parseChurnReportV1({
			...minimalReport,
			schemaVersion: "1.4.0",
		})
		expect(parsed.schemaVersion).toBe("1.4.0")
	})

	it("rejects unsupported report schema major version", () => {
		expect(() =>
			parseChurnReportV1({
				...minimalReport,
				schemaVersion: "2.0.0",
			}),
		).toThrow(/major version 1/)
	})
})
