import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
	buildLocalManifest,
	buildLocalManifestContent,
	buildRemoteManifestPath,
	detectAssetType,
	inferOwnerGroup,
	parseManifest,
} from "../src/churn"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
} from "../src/churnSchema"

async function createTempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function ensureFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, content, "utf8")
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex")
}

describe("churn manifest helpers", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true })
		}
		tempDirs.length = 0
	})

	it("builds remote manifest path under .deploy", () => {
		const remotePath = buildRemoteManifestPath("/var/www/app")
		expect(remotePath).toBe("/var/www/app/.deploy/manifest.json")
	})

	it("classifies asset types by extension", () => {
		expect(detectAssetType("./app.js")).toBe("js")
		expect(detectAssetType("./styles/main.css")).toBe("css")
		expect(detectAssetType("./fonts/inter.woff2")).toBe("font")
		expect(detectAssetType("./images/logo.svg")).toBe("image")
		expect(detectAssetType("./chunk.js.map")).toBe("sourcemap")
		expect(detectAssetType("./unknown.bin")).toBe("bin")
	})

	it("infers owner groups with unknown fallback", () => {
		expect(inferOwnerGroup("./vendor/runtime.js")).toBe("vendor")
		expect(inferOwnerGroup("./pages/home.js")).toBe("page")
		expect(inferOwnerGroup("./components/button.js")).toBe("component")
		expect(inferOwnerGroup("./layouts/default.js")).toBe("layout")
		expect(inferOwnerGroup("./assets/logo.svg")).toBe("unknown")
	})

	it("builds deterministic local manifest with enriched file data", async () => {
		const dir = await createTempDir("deploy-churn-manifest-")
		tempDirs.push(dir)

		const files = [
			{
				relativePath: "vendor/runtime.js",
				content: "console.log('vendor runtime')\n",
				assetType: "js",
				ownerGroup: "vendor",
			},
			{
				relativePath: "pages/home.js",
				content: "export default {}\n",
				assetType: "js",
				ownerGroup: "page",
			},
			{
				relativePath: "components/button.css",
				content: ".btn { color: red; }\n",
				assetType: "css",
				ownerGroup: "component",
			},
			{
				relativePath: "assets/logo.svg",
				content: "<svg></svg>\n",
				assetType: "image",
				ownerGroup: "unknown",
			},
		]

		for (const file of files) {
			await ensureFile(path.join(dir, file.relativePath), file.content)
		}

		const manifest = await buildLocalManifest(dir)

		expect(manifest.schema).toBe(CHURN_MANIFEST_SCHEMA)
		expect(manifest.schemaVersion).toBe(CHURN_MANIFEST_SCHEMA_VERSION)
		expect(manifest.root).toBe("public/_nuxt")
		expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

		const expectedPaths = files
			.map((file) => `./${file.relativePath.split(path.sep).join("/")}`)
			.sort()
		expect(manifest.files.map((file) => file.path)).toEqual(expectedPaths)

		const sourceByPath = new Map(
			files.map((file) => [
				`./${file.relativePath.split(path.sep).join("/")}`,
				file,
			]),
		)

		for (const entry of manifest.files) {
			const source = sourceByPath.get(entry.path)
			expect(source).toBeTruthy()
			expect(entry.size).toBe(Buffer.byteLength(source!.content, "utf8"))
			expect(entry.sha256).toBe(sha256(source!.content))
			expect(entry.assetType).toBe(source!.assetType)
			expect(entry.ownerGroup).toBe(source!.ownerGroup)
		}
	})

	it("serializes and parses manifest content", async () => {
		const dir = await createTempDir("deploy-churn-manifest-content-")
		tempDirs.push(dir)
		await ensureFile(path.join(dir, "pages/index.js"), "export default 1\n")

		const content = await buildLocalManifestContent(dir)
		expect(content.endsWith("\n")).toBe(true)

		const parsed = parseManifest(content)
		expect(parsed.schema).toBe(CHURN_MANIFEST_SCHEMA)
		expect(parsed.files).toHaveLength(1)
		expect(parsed.files[0]?.path).toBe("./pages/index.js")
		expect(parsed.files[0]?.ownerGroup).toBe("page")
	})
})
