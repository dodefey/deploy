import { describe, expect, it } from "vitest"

import {
	buildRemoteManifestPath,
	churnError,
	compareManifestMetrics,
	computeChurnFromManifests,
	normalizeManifestPath,
	parseManifest,
} from "../src/churn"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
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

describe("parseManifest", () => {
	it("parses JSON manifest payload", () => {
		const manifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "hash-a",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const parsed = parseManifest(JSON.stringify(manifest))
		expect(parsed).toEqual(manifest)
	})
})

describe("compareManifestMetrics", () => {
	it("first deploy: all files added", () => {
		const oldManifest = buildManifest([])
		const newManifest = buildManifest([
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
				ownerGroup: "page",
			},
		])

		const metrics = compareManifestMetrics(oldManifest, newManifest)
		expect(metrics).toEqual({
			totalOldFiles: 0,
			totalNewFiles: 2,
			stableFiles: 0,
			changedFiles: 0,
			addedFiles: 2,
			removedFiles: 0,
			totalOldBytes: 0,
			totalNewBytes: 300,
			stableBytes: 0,
			changedBytes: 0,
			addedBytes: 300,
			removedBytes: 0,
			downloadImpactFilesPercent: 100,
			cacheReuseFilesPercent: 0,
			downloadImpactBytesPercent: 100,
			cacheReuseBytesPercent: 0,
		})
	})

	it("mixed stable/changed/added/removed scenario", () => {
		const oldManifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "old-a",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./b.js",
				size: 150,
				sha256: "old-b",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./d.js",
				size: 50,
				sha256: "old-d",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "new-a",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./b.js",
				size: 200,
				sha256: "new-b",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./c.js",
				size: 300,
				sha256: "new-c",
				assetType: "js",
				ownerGroup: "page",
			},
		])

		const metrics = compareManifestMetrics(oldManifest, newManifest)
		expect(metrics).toEqual({
			totalOldFiles: 3,
			totalNewFiles: 3,
			stableFiles: 0,
			changedFiles: 2,
			addedFiles: 1,
			removedFiles: 1,
			totalOldBytes: 300,
			totalNewBytes: 600,
			stableBytes: 0,
			changedBytes: 300,
			addedBytes: 300,
			removedBytes: 50,
			downloadImpactFilesPercent: ((2 + 1) * 100) / 3,
			cacheReuseFilesPercent: (0 * 100) / 3,
			downloadImpactBytesPercent: ((300 + 300) * 100) / 600,
			cacheReuseBytesPercent: (0 * 100) / 600,
		})
	})

	it("treats same-size same-path hash changes as changed", () => {
		const oldManifest = buildManifest([
			{
				path: "./same-size.js",
				size: 128,
				sha256: "old-hash",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./same-size.js",
				size: 128,
				sha256: "new-hash",
				assetType: "js",
				ownerGroup: "page",
			},
		])

		const metrics = compareManifestMetrics(oldManifest, newManifest)
		expect(metrics.stableFiles).toBe(0)
		expect(metrics.changedFiles).toBe(1)
		expect(metrics.stableBytes).toBe(0)
		expect(metrics.changedBytes).toBe(128)
	})
})

describe("computeChurnFromManifests", () => {
	it("computes metrics from structured manifests", () => {
		const previous = buildManifest([
			{
				path: "./old.js",
				size: 5,
				sha256: "old",
				assetType: "js",
				ownerGroup: "unknown",
			},
		])
		const current = buildManifest([
			{
				path: "./old.js",
				size: 6,
				sha256: "new",
				assetType: "js",
				ownerGroup: "unknown",
			},
		])

		const expected = compareManifestMetrics(previous, current)
		const metrics = computeChurnFromManifests(previous, current)
		expect(metrics).toEqual(expected)
	})

	it("wraps compare failures with CHURN_COMPUTE_FAILED", () => {
		let caught: unknown
		try {
			computeChurnFromManifests(
				// @ts-ignore intentionally invalid inputs
				undefined,
				// @ts-ignore intentionally invalid inputs
				undefined,
			)
		} catch (err) {
			caught = err
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error & { cause?: unknown }).cause).toBe(
			"CHURN_COMPUTE_FAILED",
		)
	})
})

describe("churnError", () => {
	it("sets cause and message", () => {
		const err = churnError("CHURN_REMOTE_MANIFEST_FETCH_FAILED", "oops")
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe("oops")
		expect(err.cause).toBe("CHURN_REMOTE_MANIFEST_FETCH_FAILED")
	})
})

describe("normalizeManifestPath", () => {
	it('normalizes to "./relative/path" with forward slashes', () => {
		const baseDir = "/root/app/.output/public/_nuxt"
		const absolutePath = "/root/app/.output/public/_nuxt/dir/sub/file.js"
		const normalized = normalizeManifestPath(baseDir, absolutePath)
		expect(normalized).toBe("./dir/sub/file.js")
	})
})

describe("buildRemoteManifestPath", () => {
	it("builds path under .deploy", () => {
		const remoteDir = "/var/www/test"
		const pathBuilt = buildRemoteManifestPath(remoteDir)
		expect(pathBuilt).toBe("/var/www/test/.deploy/manifest.json")
	})
})
