import { describe, expect, it } from "vitest"

const modulePromise = import("./../src/churn") as Promise<
	typeof import("./../src/churn")
>

describe("parseManifest", () => {
	it("parses valid lines into path-size map", async () => {
		const { parseManifest } = await modulePromise
		const content = [
			"100  ./a.js",
			"200  ./b.css",
			"300  ./nested/c.js",
			"",
		].join("\n")

		const map = parseManifest(content)
		expect(map.size).toBe(3)
		expect(map.get("./a.js")).toBe(100)
		expect(map.get("./b.css")).toBe(200)
		expect(map.get("./nested/c.js")).toBe(300)
	})

	it("ignores empty and whitespace-only lines", async () => {
		const { parseManifest } = await modulePromise
		const content = "\n   \n100  ./a.js\n\n"
		const map = parseManifest(content)
		expect(map.size).toBe(1)
		expect(map.get("./a.js")).toBe(100)
	})

	it("skips lines with invalid size", async () => {
		const { parseManifest } = await modulePromise
		const content = ["foo  ./a.js", "NaN  ./b.js", "50  ./c.js", ""].join(
			"\n",
		)
		const map = parseManifest(content)
		expect(map.size).toBe(1)
		expect(map.get("./c.js")).toBe(50)
	})

	it("handles paths with spaces", async () => {
		const { parseManifest } = await modulePromise
		const content = "50  ./dir/with space/file.js\n"
		const map = parseManifest(content)
		expect(map.get("./dir/with space/file.js")).toBe(50)
	})

	it("handles trailing newlines without extra entries", async () => {
		const { parseManifest } = await modulePromise
		const content = "10  ./a.js\n20  ./b.js\n\n"
		const map = parseManifest(content)
		expect(map.size).toBe(2)
		expect(map.get("./a.js")).toBe(10)
		expect(map.get("./b.js")).toBe(20)
	})
})

describe("compareManifests", () => {
	it("first deploy: all files added", async () => {
		const { compareManifests } = await modulePromise
		const newContent = [
			"100  ./a.js",
			"200  ./b.js",
			"300  ./c.js",
			"",
		].join("\n")
		const metrics = compareManifests("", newContent)
		expect(metrics).toEqual({
			totalOldFiles: 0,
			totalNewFiles: 3,
			stableFiles: 0,
			changedFiles: 0,
			addedFiles: 3,
			removedFiles: 0,
			totalOldBytes: 0,
			totalNewBytes: 600,
			stableBytes: 0,
			changedBytes: 0,
			addedBytes: 600,
			removedBytes: 0,
			downloadImpactFilesPercent: 100,
			cacheReuseFilesPercent: 0,
			downloadImpactBytesPercent: 100,
			cacheReuseBytesPercent: 0,
		})
	})

	it("identical manifests: no churn", async () => {
		const { compareManifests } = await modulePromise
		const content = ["100  ./a.js", "200  ./b.js", "300  ./c.js", ""].join(
			"\n",
		)
		const metrics = compareManifests(content, content)
		expect(metrics).toEqual({
			totalOldFiles: 3,
			totalNewFiles: 3,
			stableFiles: 3,
			changedFiles: 0,
			addedFiles: 0,
			removedFiles: 0,
			totalOldBytes: 600,
			totalNewBytes: 600,
			stableBytes: 600,
			changedBytes: 0,
			addedBytes: 0,
			removedBytes: 0,
			downloadImpactFilesPercent: 0,
			cacheReuseFilesPercent: 100,
			downloadImpactBytesPercent: 0,
			cacheReuseBytesPercent: 100,
		})
	})

	it("mixed stable/changed/added/removed scenario", async () => {
		const { compareManifests } = await modulePromise
		const oldContent = [
			"100  ./a.js",
			"150  ./b.js",
			"50  ./d.js",
			"",
		].join("\n")
		const newContent = [
			"100  ./a.js",
			"200  ./b.js",
			"300  ./c.js",
			"",
		].join("\n")
		const metrics = compareManifests(oldContent, newContent)
		expect(metrics).toEqual({
			totalOldFiles: 3,
			totalNewFiles: 3,
			stableFiles: 1,
			changedFiles: 1,
			addedFiles: 1,
			removedFiles: 1,
			totalOldBytes: 300,
			totalNewBytes: 600,
			stableBytes: 100,
			changedBytes: 200,
			addedBytes: 300,
			removedBytes: 50,
			downloadImpactFilesPercent: ((1 + 1) * 100) / 3,
			cacheReuseFilesPercent: (1 * 100) / 3,
			downloadImpactBytesPercent: ((200 + 300) * 100) / 600,
			cacheReuseBytesPercent: (100 * 100) / 600,
		})
	})

	it("all files removed when new manifest empty", async () => {
		const { compareManifests } = await modulePromise
		const oldContent = [
			"100  ./a.js",
			"200  ./b.js",
			"300  ./c.js",
			"",
		].join("\n")
		const metrics = compareManifests(oldContent, "")
		expect(metrics).toEqual({
			totalOldFiles: 3,
			totalNewFiles: 0,
			stableFiles: 0,
			changedFiles: 0,
			addedFiles: 0,
			removedFiles: 3,
			totalOldBytes: 600,
			totalNewBytes: 0,
			stableBytes: 0,
			changedBytes: 0,
			addedBytes: 0,
			removedBytes: 600,
			downloadImpactFilesPercent: 0,
			cacheReuseFilesPercent: 0,
			downloadImpactBytesPercent: 0,
			cacheReuseBytesPercent: 0,
		})
	})

	it("only size changes, no added/removed paths", async () => {
		const { compareManifests } = await modulePromise
		const oldContent = ["100  ./a.js", "200  ./b.js", ""].join("\n")
		const newContent = ["150  ./a.js", "250  ./b.js", ""].join("\n")
		const metrics = compareManifests(oldContent, newContent)
		expect(metrics).toEqual({
			totalOldFiles: 2,
			totalNewFiles: 2,
			stableFiles: 0,
			changedFiles: 2,
			addedFiles: 0,
			removedFiles: 0,
			totalOldBytes: 300,
			totalNewBytes: 400,
			stableBytes: 0,
			changedBytes: 400,
			addedBytes: 0,
			removedBytes: 0,
			downloadImpactFilesPercent: 100,
			cacheReuseFilesPercent: 0,
			downloadImpactBytesPercent: 100,
			cacheReuseBytesPercent: 0,
		})
	})

	it("ignores malformed lines gracefully", async () => {
		const { compareManifests } = await modulePromise
		const oldContent = ["100  ./a.js", "foo  ./bad.js", ""].join("\n")
		const newContent = ["100  ./a.js", "50  ./c.js", ""].join("\n")
		const metrics = compareManifests(oldContent, newContent)
		expect(metrics.totalOldFiles).toBe(1)
		expect(metrics.totalNewFiles).toBe(2)
		expect(metrics.addedFiles).toBe(1)
		expect(metrics.removedFiles).toBe(0)
	})
})

describe("computeChurnFromManifests", () => {
	it('treats kind:"none" as empty old manifest', async () => {
		const { computeChurnFromManifests, compareManifests } =
			await modulePromise
		const localContent = ["10  ./a.js", "20  ./b.js", ""].join("\n")
		const expected = compareManifests("", localContent)
		const metrics = computeChurnFromManifests(
			{ kind: "none" },
			localContent,
		)
		expect(metrics).toEqual(expected)
	})

	it('passes through kind:"ok" content', async () => {
		const { computeChurnFromManifests, compareManifests } =
			await modulePromise
		const oldContent = "5  ./old.js\n"
		const newContent = "6  ./old.js\n"
		const expected = compareManifests(oldContent, newContent)
		const metrics = computeChurnFromManifests(
			{ kind: "ok", content: oldContent },
			newContent,
		)
		expect(metrics).toEqual(expected)
	})

	it("wraps compare failures with CHURN_COMPUTE_FAILED", async () => {
		const { computeChurnFromManifests } = await modulePromise
		let caught: any
		try {
			computeChurnFromManifests(
				// @ts-expect-error intentionally invalid inputs to force error path
				{ kind: "ok", content: undefined },
				undefined,
			)
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(Error)
		expect(caught?.cause).toBe("CHURN_COMPUTE_FAILED")
	})
})

describe("churnError", () => {
	it("sets cause and message", async () => {
		const { churnError } = await modulePromise
		const err = churnError("CHURN_REMOTE_MANIFEST_FETCH_FAILED", "oops")
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe("oops")
		expect(err.cause).toBe("CHURN_REMOTE_MANIFEST_FETCH_FAILED")
	})
})

describe("normalizeManifestPath", () => {
	it('normalizes to "./relative/path" with forward slashes', async () => {
		const { normalizeManifestPath } = await modulePromise
		const baseDir = "/root/app/.output/public/_nuxt"
		const absolutePath = "/root/app/.output/public/_nuxt/dir/sub/file.js"
		const normalized = normalizeManifestPath(baseDir, absolutePath)
		expect(normalized).toBe("./dir/sub/file.js")
	})
})

describe("buildRemoteManifestPath", () => {
	it("builds path under .deploy/client-manifests", async () => {
		const { buildRemoteManifestPath } = await modulePromise
		const remoteDir = "/var/www/test"
		const pathBuilt = buildRemoteManifestPath(remoteDir)
		expect(pathBuilt).toBe(
			"/var/www/test/.deploy/client-manifests/_nuxt-manifest.sha",
		)
	})
})
