import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
	CHURN_MANIFEST_SCHEMA,
	CHURN_MANIFEST_SCHEMA_VERSION,
	CHURN_REPORT_METRIC_SET_VERSION,
	CHURN_REPORT_SCHEMA,
	CHURN_REPORT_SCHEMA_VERSION,
	type TChurnCategoryTotals,
	type TChurnDiagnosticsCategories,
	type TChurnReportV1,
	parseChurnManifestV2Json,
	type TChurnManifestV2,
	type TChurnManifestV2File,
} from "./churnSchema.js"

const CLIENT_SUBDIR = "public/_nuxt"
const CLIENT_MANIFEST_NAME = "manifest"
const CLIENT_MANIFEST_V2_NAME = "manifest.v2.json"

const DEFAULT_SSH_OPTS = [
	"-4",
	"-o",
	"ServerAliveInterval=30",
	"-o",
	"ServerAliveCountMax=6",
	"-o",
	"TCPKeepAlive=yes",
	"-o",
	"ConnectTimeout=20",
]

export interface TChurnOptions {
	buildDir: string
	sshConnectionString: string
	remoteDir: string
	dryRun: boolean
}

export interface TChurnMetrics {
	// File counts
	totalOldFiles: number
	totalNewFiles: number

	stableFiles: number
	changedFiles: number
	addedFiles: number
	removedFiles: number

	// Byte counts
	totalOldBytes: number
	totalNewBytes: number

	stableBytes: number
	changedBytes: number
	addedBytes: number
	removedBytes: number

	// Percentages based on file counts
	downloadImpactFilesPercent: number
	cacheReuseFilesPercent: number

	// Percentages based on bytes
	downloadImpactBytesPercent: number
	cacheReuseBytesPercent: number
}

type TRemoteManifestResult =
	| { kind: "none" }
	| { kind: "error"; reason: string }
	| { kind: "ok"; content: string }

type TRemoteManifestV2Result =
	| { kind: "none" }
	| { kind: "error"; reason: string }
	| { kind: "ok"; manifest: TChurnManifestV2; content: string }

interface TSshCommandResult {
	code: number | null
	stdout: string
	stderr: string
	spawnError?: string
}

export type TChurnErrorCode =
	| "CHURN_NO_CLIENT_DIR"
	| "CHURN_REMOTE_MANIFEST_FETCH_FAILED"
	| "CHURN_REMOTE_MANIFEST_UPLOAD_FAILED"
	| "CHURN_COMPUTE_FAILED"

export interface TChurnReportOptions extends TChurnOptions {
	profileName?: string
	runMode?: string
	producerName?: string
	producerVersion?: string
}

export interface TBuildChurnReportInput {
	metrics: TChurnMetrics
	dryRun: boolean
	diagnosticsDiff?: TManifestV2DiffResult
	diagnosticsWarning?: string
	profileName?: string
	runMode?: string
	producerName?: string
	producerVersion?: string
	reportId?: string
	generatedAt?: string
}

export async function computeClientChurn(
	opts: TChurnOptions,
): Promise<TChurnMetrics> {
	const buildDir = path.resolve(opts.buildDir)
	const clientDir = path.join(buildDir, CLIENT_SUBDIR)

	await ensureClientDirectory(clientDir)

	let localManifestContent: string
	try {
		localManifestContent = await buildLocalManifestContent(clientDir)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw churnError("CHURN_COMPUTE_FAILED", message)
	}

	const remoteManifestPath = buildRemoteManifestPath(opts.remoteDir)
	const remoteManifest = await loadRemoteManifest(
		opts.sshConnectionString,
		remoteManifestPath,
		DEFAULT_SSH_OPTS,
	)

	if (remoteManifest.kind === "error") {
		throw churnError(
			"CHURN_REMOTE_MANIFEST_FETCH_FAILED",
			remoteManifest.reason,
		)
	}

	const metrics = computeChurnFromManifests(
		remoteManifest,
		localManifestContent,
	)

	if (!opts.dryRun) {
		await uploadRemoteManifest(
			opts.sshConnectionString,
			remoteManifestPath,
			localManifestContent,
			DEFAULT_SSH_OPTS,
		)
	}

	return metrics
}

export async function computeClientChurnReport(
	opts: TChurnReportOptions,
): Promise<TChurnReportV1> {
	const buildDir = path.resolve(opts.buildDir)
	const clientDir = path.join(buildDir, CLIENT_SUBDIR)

	await ensureClientDirectory(clientDir)

	let localManifestContent: string
	let localManifestV2: TChurnManifestV2
	let localManifestV2Content: string
	try {
		localManifestContent = await buildLocalManifestContent(clientDir)
		localManifestV2 = await buildLocalManifestV2(clientDir)
		localManifestV2Content = JSON.stringify(localManifestV2) + "\n"
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw churnError("CHURN_COMPUTE_FAILED", message)
	}

	const remoteManifestPath = buildRemoteManifestPath(opts.remoteDir)
	const remoteManifestV2Path = buildRemoteManifestV2Path(opts.remoteDir)
	const remoteManifest = await loadRemoteManifest(
		opts.sshConnectionString,
		remoteManifestPath,
		DEFAULT_SSH_OPTS,
	)

	if (remoteManifest.kind === "error") {
		throw churnError(
			"CHURN_REMOTE_MANIFEST_FETCH_FAILED",
			remoteManifest.reason,
		)
	}

	const remoteManifestV2 = await loadRemoteManifestV2(
		opts.sshConnectionString,
		remoteManifestV2Path,
		DEFAULT_SSH_OPTS,
	)

	const metrics = computeChurnFromManifests(
		remoteManifest,
		localManifestContent,
	)

	let diagnosticsDiff: TManifestV2DiffResult | undefined
	let diagnosticsWarning: string | undefined
	if (remoteManifestV2.kind === "ok") {
		diagnosticsDiff = compareManifestsV2(
			remoteManifestV2.manifest,
			localManifestV2,
		)
	} else if (remoteManifestV2.kind === "none") {
		diagnosticsWarning =
			"Enhanced diagnostics unavailable: no previous manifest.v2 baseline."
	} else {
		diagnosticsWarning = `Enhanced diagnostics unavailable: ${remoteManifestV2.reason}`
	}

	if (!opts.dryRun) {
		await uploadRemoteManifest(
			opts.sshConnectionString,
			remoteManifestPath,
			localManifestContent,
			DEFAULT_SSH_OPTS,
		)
		await uploadRemoteManifestV2(
			opts.sshConnectionString,
			remoteManifestV2Path,
			localManifestV2Content,
			DEFAULT_SSH_OPTS,
		)
	}

	return buildChurnReport({
		metrics,
		dryRun: opts.dryRun,
		diagnosticsDiff,
		diagnosticsWarning,
		profileName: opts.profileName,
		runMode: opts.runMode,
		producerName: opts.producerName,
		producerVersion: opts.producerVersion,
	})
}

async function ensureClientDirectory(dir: string): Promise<void> {
	const exists = await directoryExists(dir)
	if (!exists) {
		throw churnError(
			"CHURN_NO_CLIENT_DIR",
			`Client directory does not exist: ${dir}`,
		)
	}
}

export function buildRemoteManifestPath(remoteDir: string): string {
	// Keep the manifest outside the rsync'd .output tree so it survives deploys.
	return `${remoteDir}/.deploy/${CLIENT_MANIFEST_NAME}`
}

export function buildRemoteManifestV2Path(remoteDir: string): string {
	// Keep the manifest outside the rsync'd .output tree so it survives deploys.
	return `${remoteDir}/.deploy/${CLIENT_MANIFEST_V2_NAME}`
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dir)
		return stat.isDirectory()
	} catch {
		return false
	}
}

async function buildLocalManifestContent(clientDir: string): Promise<string> {
	const files = await collectFiles(clientDir)
	const entries: string[] = []

	for (const file of files) {
		const size = await getFileSize(file)
		const normalizedPath = normalizeManifestPath(clientDir, file)
		entries.push(`${String(size)}  ${normalizedPath}`)
	}

	entries.sort()

	const content = entries.join("\n") + (entries.length ? "\n" : "")
	return content
}

export async function buildLocalManifestV2(
	clientDir: string,
): Promise<TChurnManifestV2> {
	const files = await collectFiles(clientDir)
	const entries: TChurnManifestV2File[] = []

	for (const file of files) {
		const size = await getFileSize(file)
		const normalizedPath = normalizeManifestPath(clientDir, file)
		const sha256 = await hashFileSha256(file)
		entries.push({
			path: normalizedPath,
			size,
			sha256,
			assetType: detectAssetType(normalizedPath),
			ownerGroup: inferOwnerGroup(normalizedPath),
		})
	}

	entries.sort((left, right) => left.path.localeCompare(right.path))

	return {
		schema: CHURN_MANIFEST_SCHEMA,
		schemaVersion: CHURN_MANIFEST_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		root: CLIENT_SUBDIR,
		files: entries,
	}
}

export async function buildLocalManifestV2Content(
	clientDir: string,
): Promise<string> {
	const manifest = await buildLocalManifestV2(clientDir)
	return JSON.stringify(manifest) + "\n"
}

async function collectFiles(rootDir: string): Promise<string[]> {
	const result: string[] = []

	async function walk(dir: string) {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(fullPath)
			} else if (entry.isFile()) {
				result.push(fullPath)
			}
		}
	}

	await walk(rootDir)
	return result
}

async function getFileSize(filePath: string): Promise<number> {
	const stat = await fs.stat(filePath)
	return stat.size
}

async function hashFileSha256(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath)
	return createHash("sha256").update(content).digest("hex")
}

export function normalizeManifestPath(
	baseDir: string,
	absolutePath: string,
): string {
	const relativePath = path.relative(baseDir, absolutePath)
	return "./" + relativePath.split(path.sep).join("/")
}

export function detectAssetType(normalizedPath: string): string {
	const extension = path.posix.extname(normalizedPath).toLowerCase()

	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
		return "js"
	}
	if (extension === ".css") return "css"
	if (extension === ".map") return "sourcemap"
	if (extension === ".html") return "html"
	if (extension === ".json") return "json"
	if (extension === ".wasm") return "wasm"
	if (
		extension === ".png" ||
		extension === ".jpg" ||
		extension === ".jpeg" ||
		extension === ".gif" ||
		extension === ".webp" ||
		extension === ".avif" ||
		extension === ".svg" ||
		extension === ".ico"
	) {
		return "image"
	}
	if (
		extension === ".woff" ||
		extension === ".woff2" ||
		extension === ".ttf" ||
		extension === ".otf"
	) {
		return "font"
	}
	if (!extension) return "unknown"
	return extension.slice(1)
}

export function inferOwnerGroup(normalizedPath: string): string {
	const trimmed = normalizedPath.startsWith("./")
		? normalizedPath.slice(2)
		: normalizedPath
	const segments = trimmed.toLowerCase().split("/")

	if (
		segments.includes("vendor") ||
		segments.includes("node_modules") ||
		segments.some((segment) => segment.startsWith("vendor-"))
	) {
		return "vendor"
	}
	if (
		segments.includes("layouts") ||
		segments.includes("layout") ||
		segments.some((segment) => segment.startsWith("layout-"))
	) {
		return "layout"
	}
	if (
		segments.includes("pages") ||
		segments.includes("page") ||
		segments.some((segment) => segment.startsWith("page-"))
	) {
		return "page"
	}
	if (
		segments.includes("components") ||
		segments.includes("component") ||
		segments.some((segment) => segment.startsWith("component-"))
	) {
		return "component"
	}

	return "unknown"
}

function shellQuoteSingle(value: string): string {
	return "'" + value.replace(/'/g, `'"'"'`) + "'"
}

async function loadRemoteManifest(
	sshConnectionString: string,
	remoteManifestPath: string,
	sshOpts: string[],
): Promise<TRemoteManifestResult> {
	const quotedPath = shellQuoteSingle(remoteManifestPath)

	const existsResult = await runSshCommand(
		sshConnectionString,
		sshOpts,
		`test -f ${quotedPath}`,
	)

	if (existsResult.spawnError) {
		return { kind: "error", reason: existsResult.spawnError }
	}

	if (existsResult.code === 0) {
		// exists, continue to read
	} else if (existsResult.code === 1 && !existsResult.stderr.trim()) {
		return { kind: "none" }
	} else {
		return {
			kind: "error",
			reason:
				existsResult.stderr ||
				`ssh exited with code ${String(existsResult.code)} checking manifest`,
		}
	}

	const contentResult = await runSshCommand(
		sshConnectionString,
		sshOpts,
		`cat ${quotedPath}`,
	)

	if (contentResult.spawnError) {
		return { kind: "error", reason: contentResult.spawnError }
	}

	if (contentResult.code !== 0) {
		return {
			kind: "error",
			reason:
				contentResult.stderr ||
				`ssh exited with code ${String(contentResult.code)} reading manifest`,
		}
	}

	return { kind: "ok", content: contentResult.stdout }
}

export async function loadRemoteManifestV2(
	sshConnectionString: string,
	remoteManifestPath: string,
	sshOpts: string[] = DEFAULT_SSH_OPTS,
): Promise<TRemoteManifestV2Result> {
	const raw = await loadRemoteManifest(
		sshConnectionString,
		remoteManifestPath,
		sshOpts,
	)

	if (raw.kind !== "ok") {
		return raw
	}

	try {
		const manifest = parseChurnManifestV2Json(raw.content)
		return { kind: "ok", manifest, content: raw.content }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			kind: "error",
			reason: `Invalid churn manifest v2 format at ${remoteManifestPath}: ${message}`,
		}
	}
}

async function uploadRemoteManifest(
	sshConnectionString: string,
	remoteManifestPath: string,
	manifestContent: string,
	sshOpts: string[],
): Promise<void> {
	const quotedPath = shellQuoteSingle(remoteManifestPath)
	const quotedDir = shellQuoteSingle(path.dirname(remoteManifestPath))
	const manifestBase64 = Buffer.from(manifestContent, "utf8").toString(
		"base64",
	)

	const command = [
		`mkdir -p ${quotedDir}`,
		`base64 -d > ${quotedPath} <<'EOF'`,
		manifestBase64,
		"EOF",
	].join("\n")

	const result = await runSshCommand(sshConnectionString, sshOpts, command)

	if (result.spawnError) {
		throw churnError(
			"CHURN_REMOTE_MANIFEST_UPLOAD_FAILED",
			result.spawnError,
		)
	}

	if (result.code !== 0) {
		throw churnError(
			"CHURN_REMOTE_MANIFEST_UPLOAD_FAILED",
			result.stderr ||
				`ssh exited with code ${String(result.code)} uploading manifest`,
		)
	}
}

export async function uploadRemoteManifestV2(
	sshConnectionString: string,
	remoteManifestPath: string,
	manifestContent: string,
	sshOpts: string[] = DEFAULT_SSH_OPTS,
): Promise<void> {
	await uploadRemoteManifest(
		sshConnectionString,
		remoteManifestPath,
		manifestContent,
		sshOpts,
	)
}

function runSshCommand(
	sshConnectionString: string,
	sshOpts: string[],
	command: string,
): Promise<TSshCommandResult> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let spawnError: string | undefined
		let resolved = false

		const finish = (result: TSshCommandResult) => {
			if (resolved) return
			resolved = true
			resolve(result)
		}

		const child = spawn("ssh", [...sshOpts, sshConnectionString, command], {
			stdio: ["ignore", "pipe", "pipe"],
		})

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk)
		})

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk)
		})

		child.on("error", (err) => {
			spawnError = String(err)
			stderr += String(err)
			finish({ code: 1, stdout, stderr, spawnError })
		})

		child.on("exit", (code) => {
			finish({ code, stdout, stderr, spawnError })
		})
	})
}

export function parseManifest(content: string): Map<string, number> {
	const map = new Map<string, number>()
	const lines = content.split("\n")
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const [sizeStr, ...rest] = trimmed.split(/\s+/)
		const filePath = rest.join(" ")
		const size = Number(sizeStr)
		if (!filePath || !Number.isFinite(size)) continue
		map.set(filePath, size)
	}
	return map
}

export function parseManifestV2(content: string): TChurnManifestV2 {
	return parseChurnManifestV2Json(content)
}

export interface TManifestV2FilePair {
	oldFile: TChurnManifestV2File
	newFile: TChurnManifestV2File
}

export interface TManifestV2DiffResult {
	categories: Required<TChurnDiagnosticsCategories>
	reusedExact: TManifestV2FilePair[]
	changedSamePath: TManifestV2FilePair[]
	renamedSameHash: TManifestV2FilePair[]
	newContent: TChurnManifestV2File[]
	removed: TChurnManifestV2File[]
}

export function compareManifestsV2(
	oldManifest: TChurnManifestV2,
	newManifest: TChurnManifestV2,
): TManifestV2DiffResult {
	const sortedOld = [...oldManifest.files].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
	const sortedNew = [...newManifest.files].sort((left, right) =>
		left.path.localeCompare(right.path),
	)

	const oldByPath = new Map(sortedOld.map((file) => [file.path, file]))
	const newByPath = new Map(sortedNew.map((file) => [file.path, file]))

	const reusedExact: TManifestV2FilePair[] = []
	const changedSamePath: TManifestV2FilePair[] = []
	const addedCandidates: TChurnManifestV2File[] = []

	for (const newFile of sortedNew) {
		const oldFile = oldByPath.get(newFile.path)
		if (!oldFile) {
			addedCandidates.push(newFile)
			continue
		}

		if (oldFile.sha256 === newFile.sha256) {
			reusedExact.push({ oldFile, newFile })
			continue
		}

		changedSamePath.push({ oldFile, newFile })
	}

	const removedCandidates = sortedOld.filter((oldFile) => {
		return !newByPath.has(oldFile.path)
	})

	const removedByHash = new Map<string, TChurnManifestV2File[]>()
	for (const oldFile of removedCandidates) {
		const bucket = removedByHash.get(oldFile.sha256)
		if (bucket) {
			bucket.push(oldFile)
			continue
		}
		removedByHash.set(oldFile.sha256, [oldFile])
	}

	const renamedSameHash: TManifestV2FilePair[] = []
	const newContent: TChurnManifestV2File[] = []
	const renamedOldPaths = new Set<string>()

	for (const newFile of addedCandidates) {
		const bucket = removedByHash.get(newFile.sha256)
		if (bucket && bucket.length > 0) {
			const oldFile = bucket.shift()
			if (!oldFile) {
				newContent.push(newFile)
				continue
			}
			renamedSameHash.push({ oldFile, newFile })
			renamedOldPaths.add(oldFile.path)
			continue
		}
		newContent.push(newFile)
	}

	const removed = removedCandidates.filter((oldFile) => {
		return !renamedOldPaths.has(oldFile.path)
	})

	const categories: Required<TChurnDiagnosticsCategories> = {
		reused_exact: buildCategoryTotalsFromPairs(reusedExact),
		changed_same_path: buildCategoryTotalsFromPairs(changedSamePath),
		renamed_same_hash: buildCategoryTotalsFromPairs(renamedSameHash),
		new_content: buildCategoryTotalsFromFiles(newContent),
		removed: buildCategoryTotalsFromRemovedFiles(removed),
	}

	return {
		categories,
		reusedExact,
		changedSamePath,
		renamedSameHash,
		newContent,
		removed,
	}
}

function buildCategoryTotalsFromPairs(
	pairs: TManifestV2FilePair[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const pair of pairs) {
		bytes += pair.newFile.size
	}
	return { files: pairs.length, bytes }
}

function buildCategoryTotalsFromFiles(
	files: TChurnManifestV2File[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const file of files) {
		bytes += file.size
	}
	return { files: files.length, bytes }
}

function buildCategoryTotalsFromRemovedFiles(
	files: TChurnManifestV2File[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const file of files) {
		bytes += file.size
	}
	return { files: files.length, bytes }
}

export function buildChurnReport(
	input: TBuildChurnReportInput,
): TChurnReportV1 {
	const baselineAvailable =
		input.metrics.totalOldFiles > 0 || input.metrics.totalOldBytes > 0
	const capabilities = input.diagnosticsDiff
		? {
				hashDiff: true,
				renameDetection: "hash-match-v1",
				assetTyping: "extension-v1",
				ownerGrouping: "heuristic-v1",
			}
		: {
				hashDiff: false,
				renameDetection: "unavailable",
				assetTyping: "unavailable",
				ownerGrouping: "unavailable",
			}

	const diagnostics = input.diagnosticsDiff
		? buildReportDiagnostics(input.diagnosticsDiff)
		: undefined
	const warnings = input.diagnosticsWarning ? [input.diagnosticsWarning] : []

	return {
		schema: CHURN_REPORT_SCHEMA,
		schemaVersion: CHURN_REPORT_SCHEMA_VERSION,
		metricSetVersion: CHURN_REPORT_METRIC_SET_VERSION,
		reportId: input.reportId ?? randomUUID(),
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		producer: {
			name: input.producerName ?? "@dodefey/deploy",
			version: input.producerVersion ?? "unknown",
		},
		run: {
			profile: input.profileName ?? "unknown",
			mode: input.runMode ?? "deploy",
			dryRun: input.dryRun,
		},
		baseline: {
			available: baselineAvailable,
			kind: baselineAvailable ? "previous_deploy" : "none",
			distance: baselineAvailable ? 1 : 0,
		},
		capabilities,
		core: {
			files: {
				totalOld: input.metrics.totalOldFiles,
				totalNew: input.metrics.totalNewFiles,
				stable: input.metrics.stableFiles,
				changed: input.metrics.changedFiles,
				added: input.metrics.addedFiles,
				removed: input.metrics.removedFiles,
			},
			bytes: {
				totalOld: input.metrics.totalOldBytes,
				totalNew: input.metrics.totalNewBytes,
				stable: input.metrics.stableBytes,
				changed: input.metrics.changedBytes,
				added: input.metrics.addedBytes,
				removed: input.metrics.removedBytes,
			},
			percent: {
				downloadImpactFiles: input.metrics.downloadImpactFilesPercent,
				cacheReuseFiles: input.metrics.cacheReuseFilesPercent,
				downloadImpactBytes: input.metrics.downloadImpactBytesPercent,
				cacheReuseBytes: input.metrics.cacheReuseBytesPercent,
			},
		},
		diagnostics,
		quality: {
			comparableClass: input.diagnosticsDiff
				? "core-1+hash-v1"
				: "core-1",
			warnings,
		},
	}
}

function buildReportDiagnostics(
	diff: TManifestV2DiffResult,
): NonNullable<TChurnReportV1["diagnostics"]> {
	const downloadBytes =
		diff.categories.changed_same_path.bytes +
		diff.categories.renamed_same_hash.bytes +
		diff.categories.new_content.bytes
	const renameNoiseBytes = diff.categories.renamed_same_hash.bytes
	const renameNoisePercentOfDownloadBytes =
		downloadBytes > 0 ? (renameNoiseBytes * 100) / downloadBytes : 0

	return {
		categories: diff.categories,
		avoidableChurn: {
			renameNoiseBytes,
			renameNoisePercentOfDownloadBytes,
		},
	}
}

export function compareManifests(
	oldContent: string,
	newContent: string,
): TChurnMetrics {
	const oldMap = parseManifest(oldContent)
	const newMap = parseManifest(newContent)

	let stableFiles = 0
	let changedFiles = 0
	let addedFiles = 0
	let removedFiles = 0

	let totalOldBytes = 0
	let totalNewBytes = 0
	let stableBytes = 0
	let changedBytes = 0
	let addedBytes = 0
	let removedBytes = 0

	for (const size of oldMap.values()) {
		totalOldBytes += size
	}
	for (const size of newMap.values()) {
		totalNewBytes += size
	}

	for (const [filePath, newSize] of newMap.entries()) {
		const oldSize = oldMap.get(filePath)
		if (oldSize === undefined) {
			addedFiles++
			addedBytes += newSize
		} else if (oldSize === newSize) {
			stableFiles++
			stableBytes += newSize
		} else {
			changedFiles++
			changedBytes += newSize
		}
	}

	for (const [filePath, oldSize] of oldMap.entries()) {
		if (!newMap.has(filePath)) {
			removedFiles++
			removedBytes += oldSize
		}
	}

	const totalOldFiles = oldMap.size
	const totalNewFiles = newMap.size

	const downloadImpactFilesPercent =
		totalNewFiles > 0
			? ((changedFiles + addedFiles) * 100) / totalNewFiles
			: 0

	const cacheReuseFilesPercent =
		totalNewFiles > 0 ? (stableFiles * 100) / totalNewFiles : 0

	const downloadImpactBytesPercent =
		totalNewBytes > 0
			? ((changedBytes + addedBytes) * 100) / totalNewBytes
			: 0

	const cacheReuseBytesPercent =
		totalNewBytes > 0 ? (stableBytes * 100) / totalNewBytes : 0

	return {
		totalOldFiles,
		totalNewFiles,
		stableFiles,
		changedFiles,
		addedFiles,
		removedFiles,
		totalOldBytes,
		totalNewBytes,
		stableBytes,
		changedBytes,
		addedBytes,
		removedBytes,
		downloadImpactFilesPercent,
		cacheReuseFilesPercent,
		downloadImpactBytesPercent,
		cacheReuseBytesPercent,
	}
}

type TResolvedManifest = Exclude<TRemoteManifestResult, { kind: "error" }>

export function computeChurnFromManifests(
	remote: TResolvedManifest,
	localManifestContent: string,
): TChurnMetrics {
	try {
		return compareManifests(
			remote.kind === "none" ? "" : remote.content,
			localManifestContent,
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw churnError("CHURN_COMPUTE_FAILED", message)
	}
}

export function churnError(code: TChurnErrorCode, message: string): Error {
	const error = new Error(message)
	error.cause = code
	return error
}
