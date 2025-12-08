import { describe, expect, it } from "vitest"

import type { TChurnMetrics } from "./../src/churn"
import {
	buildHeader,
	formatBytes,
	formatChurnMetrics,
	formatPercent,
} from "./../src/churnFormat"

const baseMetrics: TChurnMetrics = {
	// Files
	totalOldFiles: 10,
	totalNewFiles: 12,
	stableFiles: 5,
	changedFiles: 2,
	addedFiles: 3,
	removedFiles: 1,
	// Bytes
	totalOldBytes: 1024 * 1024, // 1 MB
	totalNewBytes: 2 * 1024 * 1024, // 2 MB
	stableBytes: 512 * 1024,
	changedBytes: 256 * 1024,
	addedBytes: 768 * 1024,
	removedBytes: 256 * 1024,
	// Percents
	downloadImpactFilesPercent: 41.666,
	cacheReuseFilesPercent: 58.333,
	downloadImpactBytesPercent: 51.2,
	cacheReuseBytesPercent: 48.8,
}

describe("churnFormat", () => {
	describe("header selection", () => {
		it("no baseline + dry run", () => {
			const m = { ...baseMetrics, totalOldFiles: 0, totalOldBytes: 0 }
			const header = buildHeader(m, { dryRun: true })
			expect(header).toBe(
				"Client cache impact (no previous baseline, dry run; baseline not updated)",
			)
		})

		it("no baseline + live", () => {
			const m = { ...baseMetrics, totalOldFiles: 0, totalOldBytes: 0 }
			const header = buildHeader(m, { dryRun: false })
			expect(header).toBe("Client cache impact (no previous baseline)")
		})

		it("baseline + dry run", () => {
			const header = buildHeader(baseMetrics, { dryRun: true })
			expect(header).toBe(
				"Client cache impact (dry run; baseline not updated)",
			)
		})

		it("baseline + live", () => {
			const header = buildHeader(baseMetrics, { dryRun: false })
			expect(header).toBe("Client cache impact")
		})
	})

	describe("formatPercent", () => {
		it("rounds and fixes to one decimal", () => {
			expect(formatPercent(0)).toBe("0.0")
			expect(formatPercent(0.04)).toBe("0.0")
			expect(formatPercent(0.05)).toBe("0.1")
			expect(formatPercent(99.96)).toBe("100.0")
		})
	})

	describe("formatBytes", () => {
		it("formats bytes to KB/MB", () => {
			expect(formatBytes(0)).toBe("0.0 KB")
			expect(formatBytes(512)).toBe("0.5 KB")
			expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
		})
	})

	describe("full string", () => {
		it("renders the complete 3-line summary", () => {
			const summary = formatChurnMetrics(baseMetrics, { dryRun: false })
			expect(summary).toBe(
				[
					"Client cache impact",
					"  Files: 41.7% new/changed, 58.3% reused (2 changed, 3 added, 1 removed; 10 -> 12 files)",
					"  Bytes: 51.2% new/changed, 48.8% reused (256.0 KB changed, 768.0 KB added, 256.0 KB removed; 1.0 MB -> 2.0 MB)",
				].join("\n"),
			)
		})
	})
})
