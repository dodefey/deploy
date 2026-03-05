import { describe, expect, it } from "vitest"

import { compareManifestsV2 } from "../src/churn"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
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

describe("compareManifestsV2", () => {
	it("classifies exact reuse", () => {
		const manifest = buildManifest([
			{
				path: "./a.js",
				size: 100,
				sha256: "hash-a",
				assetType: "js",
				ownerGroup: "page",
			},
		])

		const diff = compareManifestsV2(manifest, manifest)

		expect(diff.categories).toEqual({
			reused_exact: { files: 1, bytes: 100 },
			changed_same_path: { files: 0, bytes: 0 },
			renamed_same_hash: { files: 0, bytes: 0 },
			new_content: { files: 0, bytes: 0 },
			removed: { files: 0, bytes: 0 },
		})
		expect(diff.reusedExact).toHaveLength(1)
		expect(diff.changedSamePath).toHaveLength(0)
		expect(diff.renamedSameHash).toHaveLength(0)
		expect(diff.newContent).toHaveLength(0)
		expect(diff.removed).toHaveLength(0)
	})

	it("classifies same-path hash changes as changed_same_path", () => {
		const oldManifest = buildManifest([
			{
				path: "./app.js",
				size: 100,
				sha256: "old-hash",
				assetType: "js",
				ownerGroup: "page",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./app.js",
				size: 120,
				sha256: "new-hash",
				assetType: "js",
				ownerGroup: "page",
			},
		])

		const diff = compareManifestsV2(oldManifest, newManifest)
		expect(diff.categories.changed_same_path).toEqual({
			files: 1,
			bytes: 120,
		})
		expect(diff.changedSamePath).toHaveLength(1)
		expect(diff.changedSamePath[0]?.oldFile.path).toBe("./app.js")
		expect(diff.changedSamePath[0]?.newFile.path).toBe("./app.js")
	})

	it("classifies renamed_same_hash, new_content, and removed in one run", () => {
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
				ownerGroup: "page",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./renamed-a.js",
				size: 100,
				sha256: "h-a",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./c.js",
				size: 300,
				sha256: "h-c",
				assetType: "js",
				ownerGroup: "page",
			},
		])

		const diff = compareManifestsV2(oldManifest, newManifest)
		expect(diff.categories).toEqual({
			reused_exact: { files: 0, bytes: 0 },
			changed_same_path: { files: 0, bytes: 0 },
			renamed_same_hash: { files: 1, bytes: 100 },
			new_content: { files: 1, bytes: 300 },
			removed: { files: 1, bytes: 200 },
		})
		expect(diff.renamedSameHash[0]?.oldFile.path).toBe("./a.js")
		expect(diff.renamedSameHash[0]?.newFile.path).toBe("./renamed-a.js")
		expect(diff.newContent[0]?.path).toBe("./c.js")
		expect(diff.removed[0]?.path).toBe("./b.js")
	})

	it("matches duplicate hashes deterministically by sorted old paths", () => {
		const oldManifest = buildManifest([
			{
				path: "./z-old.js",
				size: 30,
				sha256: "dup-hash",
				assetType: "js",
				ownerGroup: "vendor",
			},
			{
				path: "./a-old.js",
				size: 10,
				sha256: "dup-hash",
				assetType: "js",
				ownerGroup: "vendor",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./m-new.js",
				size: 10,
				sha256: "dup-hash",
				assetType: "js",
				ownerGroup: "vendor",
			},
		])

		const diff = compareManifestsV2(oldManifest, newManifest)
		expect(diff.renamedSameHash).toHaveLength(1)
		expect(diff.renamedSameHash[0]?.oldFile.path).toBe("./a-old.js")
		expect(diff.renamedSameHash[0]?.newFile.path).toBe("./m-new.js")
		expect(diff.removed.map((file) => file.path)).toEqual(["./z-old.js"])
	})

	it("reconciles category totals to old/new manifest totals", () => {
		const oldManifest = buildManifest([
			{
				path: "./stable.js",
				size: 100,
				sha256: "h-stable",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./changed.js",
				size: 200,
				sha256: "h-old",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./to-rename.js",
				size: 300,
				sha256: "h-rename",
				assetType: "js",
				ownerGroup: "vendor",
			},
			{
				path: "./to-remove.js",
				size: 400,
				sha256: "h-remove",
				assetType: "js",
				ownerGroup: "vendor",
			},
		])
		const newManifest = buildManifest([
			{
				path: "./stable.js",
				size: 100,
				sha256: "h-stable",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./changed.js",
				size: 250,
				sha256: "h-new",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				path: "./renamed.js",
				size: 300,
				sha256: "h-rename",
				assetType: "js",
				ownerGroup: "vendor",
			},
			{
				path: "./new.js",
				size: 500,
				sha256: "h-new-content",
				assetType: "js",
				ownerGroup: "component",
			},
		])

		const diff = compareManifestsV2(oldManifest, newManifest)
		const categories = diff.categories

		const totalNewFilesFromCategories =
			categories.reused_exact.files +
			categories.changed_same_path.files +
			categories.renamed_same_hash.files +
			categories.new_content.files
		const totalNewBytesFromCategories =
			categories.reused_exact.bytes +
			categories.changed_same_path.bytes +
			categories.renamed_same_hash.bytes +
			categories.new_content.bytes

		const totalOldFilesFromCategories =
			categories.reused_exact.files +
			categories.changed_same_path.files +
			categories.renamed_same_hash.files +
			categories.removed.files
		const totalOldBytesFromDiff =
			diff.reusedExact.reduce((sum, pair) => sum + pair.oldFile.size, 0) +
			diff.changedSamePath.reduce((sum, pair) => sum + pair.oldFile.size, 0) +
			diff.renamedSameHash.reduce((sum, pair) => sum + pair.oldFile.size, 0) +
			diff.removed.reduce((sum, file) => sum + file.size, 0)

		const expectedNewFiles = newManifest.files.length
		const expectedNewBytes = newManifest.files.reduce((sum, file) => {
			return sum + file.size
		}, 0)
		const expectedOldFiles = oldManifest.files.length
		const expectedOldBytes = oldManifest.files.reduce((sum, file) => {
			return sum + file.size
		}, 0)

		expect(totalNewFilesFromCategories).toBe(expectedNewFiles)
		expect(totalNewBytesFromCategories).toBe(expectedNewBytes)
		expect(totalOldFilesFromCategories).toBe(expectedOldFiles)
		expect(totalOldBytesFromDiff).toBe(expectedOldBytes)
	})
})
