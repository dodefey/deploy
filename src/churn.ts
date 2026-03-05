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
	type TChurnManifest,
	type TChurnManifestFile,
	type TChurnReportV1,
	parseChurnManifestJson,
} from "./churnSchema.js"

const CLIENT_SUBDIR = "public/_nuxt"
const CLIENT_MANIFEST_NAME = "manifest.json"

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
	| { kind: "ok"; manifest: TChurnManifest; content: string }

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
	groupRules?: TChurnGroupRule[]
}

export interface TChurnGroupRule {
	pattern: string
	group: string
}

export interface TBuildChurnReportInput {
	metrics: TChurnMetrics
	diagnosticsDiff: TManifestDiffResult
	dryRun: boolean
	profileName?: string
	runMode?: string
	producerName?: string
	producerVersion?: string
	reportId?: string
	generatedAt?: string
}

export async function computeClientChurnReport(
	opts: TChurnReportOptions,
): Promise<TChurnReportV1> {
	const buildDir = path.resolve(opts.buildDir)
	const clientDir = path.join(buildDir, CLIENT_SUBDIR)

	await ensureClientDirectory(clientDir)

	let localManifest: TChurnManifest
	let localManifestContent: string
	try {
		localManifest = await buildLocalManifest(clientDir, opts.groupRules)
		localManifestContent = JSON.stringify(localManifest) + "\n"
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw churnError("CHURN_COMPUTE_FAILED", message)
	}

	const remoteManifestPath = buildRemoteManifestPath(opts.remoteDir)
	const remoteManifestRaw = await loadRemoteManifest(
		opts.sshConnectionString,
		remoteManifestPath,
		DEFAULT_SSH_OPTS,
	)

	if (remoteManifestRaw.kind === "error") {
		throw churnError(
			"CHURN_REMOTE_MANIFEST_FETCH_FAILED",
			remoteManifestRaw.reason,
		)
	}

	const previousManifest =
		remoteManifestRaw.kind === "ok"
			? remoteManifestRaw.manifest
			: buildEmptyManifest()

	const metrics = computeChurnFromManifests(previousManifest, localManifest)
	const diagnosticsDiff = compareManifestDiff(previousManifest, localManifest)

	if (!opts.dryRun) {
		await uploadRemoteManifest(
			opts.sshConnectionString,
			remoteManifestPath,
			localManifestContent,
			DEFAULT_SSH_OPTS,
		)
	}

	return buildChurnReport({
		metrics,
		diagnosticsDiff,
		dryRun: opts.dryRun,
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

function buildEmptyManifest(): TChurnManifest {
	return {
		schema: CHURN_MANIFEST_SCHEMA,
		schemaVersion: CHURN_MANIFEST_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		root: CLIENT_SUBDIR,
		files: [],
	}
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dir)
		return stat.isDirectory()
	} catch {
		return false
	}
}

export async function buildLocalManifest(
	clientDir: string,
	groupRules: TChurnGroupRule[] = [],
): Promise<TChurnManifest> {
	const files = await collectFiles(clientDir)
	const entries: TChurnManifestFile[] = []

	for (const file of files) {
		const size = await getFileSize(file)
		const normalizedPath = normalizeManifestPath(clientDir, file)
		const sha256 = await hashFileSha256(file)
		entries.push({
			path: normalizedPath,
			size,
			sha256,
			assetType: detectAssetType(normalizedPath),
			ownerGroup: inferOwnerGroupWithRules(normalizedPath, groupRules),
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

export async function buildLocalManifestContent(
	clientDir: string,
	groupRules: TChurnGroupRule[] = [],
): Promise<string> {
	const manifest = await buildLocalManifest(clientDir, groupRules)
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

export function inferOwnerGroupWithRules(
	normalizedPath: string,
	groupRules: TChurnGroupRule[] = [],
): string {
	const matched = matchOwnerGroupRule(normalizedPath, groupRules)
	if (matched) {
		return matched
	}

	return inferOwnerGroup(normalizedPath)
}

function matchOwnerGroupRule(
	normalizedPath: string,
	groupRules: TChurnGroupRule[],
): string | undefined {
	if (!groupRules.length) return undefined

	const withoutPrefix = normalizedPath.startsWith("./")
		? normalizedPath.slice(2)
		: normalizedPath

	for (const rule of groupRules) {
		const pattern = rule.pattern.trim()
		const group = rule.group.trim()
		if (!pattern || !group) continue

		if (doesPatternMatchPath(pattern, normalizedPath, withoutPrefix)) {
			return group
		}
	}

	return undefined
}

function doesPatternMatchPath(
	pattern: string,
	normalizedPath: string,
	pathWithoutPrefix: string,
): boolean {
	const normalizedPattern = pattern.startsWith("./")
		? pattern.slice(2)
		: pattern

	if (!/[*?]/.test(normalizedPattern)) {
		return (
			normalizedPath.includes(pattern) ||
			pathWithoutPrefix.includes(normalizedPattern)
		)
	}

	const regex = globToRegExp(normalizedPattern)
	return regex.test(pathWithoutPrefix)
}

function globToRegExp(globPattern: string): RegExp {
	const escaped = globPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
	const placeholder = "__DOUBLE_STAR__"
	const withPlaceholder = escaped.replace(/\*\*/g, placeholder)
	const singleStarExpanded = withPlaceholder.replace(/\*/g, "[^/]*")
	const questionExpanded = singleStarExpanded.replace(/\?/g, "[^/]")
	const expanded = questionExpanded.replaceAll(placeholder, ".*")
	return new RegExp(`^${expanded}$`)
}

function shellQuoteSingle(value: string): string {
	return "'" + value.replace(/'/g, `'"'"'`) + "'"
}

export async function loadRemoteManifest(
	sshConnectionString: string,
	remoteManifestPath: string,
	sshOpts: string[] = DEFAULT_SSH_OPTS,
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

	try {
		const manifest = parseChurnManifestJson(contentResult.stdout)
		return {
			kind: "ok",
			manifest,
			content: contentResult.stdout,
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			kind: "error",
			reason: `Invalid churn manifest format at ${remoteManifestPath}: ${message}`,
		}
	}
}

export async function uploadRemoteManifest(
	sshConnectionString: string,
	remoteManifestPath: string,
	manifestContent: string,
	sshOpts: string[] = DEFAULT_SSH_OPTS,
): Promise<void> {
	const quotedPath = shellQuoteSingle(remoteManifestPath)
	const quotedDir = shellQuoteSingle(path.dirname(remoteManifestPath))
	const command = `mkdir -p ${quotedDir} && cat > ${quotedPath}`

	const result = await runSshCommand(
		sshConnectionString,
		sshOpts,
		command,
		manifestContent,
	)

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

function runSshCommand(
	sshConnectionString: string,
	sshOpts: string[],
	command: string,
	stdinContent?: string,
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
			stdio: ["pipe", "pipe", "pipe"],
		})

		child.stdin.on("error", (err) => {
			stderr += String(err)
		})
		child.stdin.end(stdinContent ?? "", "utf8")

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

export function parseManifest(content: string): TChurnManifest {
	return parseChurnManifestJson(content)
}

export interface TManifestFilePair {
	oldFile: TChurnManifestFile
	newFile: TChurnManifestFile
}

export interface TManifestDiffResult {
	categories: Required<TChurnDiagnosticsCategories>
	reusedExact: TManifestFilePair[]
	changedSamePath: TManifestFilePair[]
	renamedSameHash: TManifestFilePair[]
	newContent: TChurnManifestFile[]
	removed: TChurnManifestFile[]
}

export function compareManifestDiff(
	oldManifest: TChurnManifest,
	newManifest: TChurnManifest,
): TManifestDiffResult {
	const sortedOld = [...oldManifest.files].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
	const sortedNew = [...newManifest.files].sort((left, right) =>
		left.path.localeCompare(right.path),
	)

	const oldByPath = new Map(sortedOld.map((file) => [file.path, file]))
	const newByPath = new Map(sortedNew.map((file) => [file.path, file]))

	const reusedExact: TManifestFilePair[] = []
	const changedSamePath: TManifestFilePair[] = []
	const addedCandidates: TChurnManifestFile[] = []

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

	const removedByHash = new Map<string, TChurnManifestFile[]>()
	for (const oldFile of removedCandidates) {
		const bucket = removedByHash.get(oldFile.sha256)
		if (bucket) {
			bucket.push(oldFile)
			continue
		}
		removedByHash.set(oldFile.sha256, [oldFile])
	}

	const renamedSameHash: TManifestFilePair[] = []
	const newContent: TChurnManifestFile[] = []
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
	pairs: TManifestFilePair[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const pair of pairs) {
		bytes += pair.newFile.size
	}
	return { files: pairs.length, bytes }
}

function buildCategoryTotalsFromFiles(
	files: TChurnManifestFile[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const file of files) {
		bytes += file.size
	}
	return { files: files.length, bytes }
}

function buildCategoryTotalsFromRemovedFiles(
	files: TChurnManifestFile[],
): TChurnCategoryTotals {
	let bytes = 0
	for (const file of files) {
		bytes += file.size
	}
	return { files: files.length, bytes }
}

export function compareManifestMetrics(
	oldManifest: TChurnManifest,
	newManifest: TChurnManifest,
): TChurnMetrics {
	const oldByPath = new Map(
		oldManifest.files.map((file) => [file.path, file]),
	)
	const newByPath = new Map(
		newManifest.files.map((file) => [file.path, file]),
	)

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

	for (const file of oldManifest.files) {
		totalOldBytes += file.size
	}
	for (const file of newManifest.files) {
		totalNewBytes += file.size
	}

	for (const [filePath, newFile] of newByPath.entries()) {
		const oldFile = oldByPath.get(filePath)
		if (!oldFile) {
			addedFiles += 1
			addedBytes += newFile.size
			continue
		}

		if (oldFile.sha256 === newFile.sha256) {
			stableFiles += 1
			stableBytes += newFile.size
			continue
		}

		changedFiles += 1
		changedBytes += newFile.size
	}

	for (const [filePath, oldFile] of oldByPath.entries()) {
		if (!newByPath.has(filePath)) {
			removedFiles += 1
			removedBytes += oldFile.size
		}
	}

	const totalOldFiles = oldByPath.size
	const totalNewFiles = newByPath.size

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

export function computeChurnFromManifests(
	previousManifest: TChurnManifest,
	currentManifest: TChurnManifest,
): TChurnMetrics {
	try {
		return compareManifestMetrics(previousManifest, currentManifest)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw churnError("CHURN_COMPUTE_FAILED", message)
	}
}

export function buildChurnReport(
	input: TBuildChurnReportInput,
): TChurnReportV1 {
	const baselineAvailable =
		input.metrics.totalOldFiles > 0 || input.metrics.totalOldBytes > 0

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
		capabilities: {
			hashDiff: true,
			renameDetection: "hash-match",
			assetTyping: "extension",
			ownerGrouping: "heuristic",
		},
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
		diagnostics: buildReportDiagnostics(input.diagnosticsDiff),
		quality: {
			comparableClass: "core-1+hash",
			warnings: [],
		},
	}
}

function buildReportDiagnostics(
	diff: TManifestDiffResult,
): NonNullable<TChurnReportV1["diagnostics"]> {
	const churnContributors = [
		...diff.changedSamePath.map((pair) => pair.newFile),
		...diff.renamedSameHash.map((pair) => pair.newFile),
		...diff.newContent,
	]

	const downloadBytes =
		diff.categories.changed_same_path.bytes +
		diff.categories.renamed_same_hash.bytes +
		diff.categories.new_content.bytes
	const renameNoiseBytes = diff.categories.renamed_same_hash.bytes
	const renameNoisePercentOfDownloadBytes =
		downloadBytes > 0 ? (renameNoiseBytes * 100) / downloadBytes : 0

	const topOffenders = {
		newContentByBytes: selectTopOffenders(diff.newContent),
		changedSamePathByBytes: selectTopOffenders(
			diff.changedSamePath.map((pair) => pair.newFile),
		),
		renamedSameHashByBytes: selectTopOffenders(
			diff.renamedSameHash.map((pair) => pair.newFile),
		),
	}

	const byAssetType = buildAttributionBuckets(
		churnContributors,
		(file) => file.assetType || "unknown",
	)
	const byOwnerGroup = buildAttributionBuckets(
		churnContributors,
		(file) => file.ownerGroup || "unknown",
	)
	const unknownOwnerBytes = churnContributors.reduce((total, file) => {
		return total + (file.ownerGroup === "unknown" ? file.size : 0)
	}, 0)

	const recommendations = buildDiagnosticsRecommendations({
		diff,
		downloadBytes,
		renameNoiseBytes,
		renameNoisePercentOfDownloadBytes,
		byAssetType,
		byOwnerGroup,
		unknownOwnerBytes,
	})

	return {
		categories: diff.categories,
		avoidableChurn: {
			renameNoiseBytes,
			renameNoisePercentOfDownloadBytes,
		},
		topOffenders,
		attribution: {
			byAssetType,
			byOwnerGroup,
			unknownOwnerBytes,
		},
		recommendations,
	}
}

function selectTopOffenders(files: TChurnManifestFile[]) {
	return [...files]
		.sort((left, right) => {
			if (left.size !== right.size) return right.size - left.size
			return left.path.localeCompare(right.path)
		})
		.slice(0, 5)
		.map((file) => ({
			path: file.path,
			bytes: file.size,
			assetType: file.assetType,
			ownerGroup: file.ownerGroup,
		}))
}

function buildAttributionBuckets(
	files: TChurnManifestFile[],
	resolveKey: (file: TChurnManifestFile) => string,
) {
	const bucketMap = new Map<string, { files: number; bytes: number }>()

	for (const file of files) {
		const key = resolveKey(file)
		const current = bucketMap.get(key)
		if (!current) {
			bucketMap.set(key, { files: 1, bytes: file.size })
			continue
		}
		current.files += 1
		current.bytes += file.size
	}

	return [...bucketMap.entries()]
		.map(([key, totals]) => ({
			key,
			files: totals.files,
			bytes: totals.bytes,
		}))
		.sort((left, right) => {
			if (left.bytes !== right.bytes) return right.bytes - left.bytes
			return left.key.localeCompare(right.key)
		})
}

function buildDiagnosticsRecommendations(input: {
	diff: TManifestDiffResult
	downloadBytes: number
	renameNoiseBytes: number
	renameNoisePercentOfDownloadBytes: number
	byAssetType: Array<{ key: string; files: number; bytes: number }>
	byOwnerGroup: Array<{ key: string; files: number; bytes: number }>
	unknownOwnerBytes: number
}): string[] {
	const recommendations: string[] = []

	if (
		input.renameNoiseBytes > 0 &&
		input.renameNoisePercentOfDownloadBytes >= 25
	) {
		recommendations.push(
			"High rename churn detected. Stabilize chunk and asset naming to improve client cache reuse.",
		)
	}

	if (
		input.diff.categories.new_content.bytes >
		input.diff.categories.changed_same_path.bytes
	) {
		recommendations.push(
			"New content dominates download impact. Focus on code-splitting and reducing fresh bundle bytes.",
		)
	}

	if (input.byOwnerGroup.length > 0 && input.downloadBytes > 0) {
		const topOwner = input.byOwnerGroup[0]
		if (topOwner.bytes / input.downloadBytes >= 0.5) {
			recommendations.push(
				`Most churn bytes are in owner group "${topOwner.key}". Start optimization work there for fastest impact.`,
			)
		}
	}

	const sourcemapBucket = input.byAssetType.find(
		(bucket) => bucket.key === "sourcemap",
	)
	if (
		sourcemapBucket &&
		input.downloadBytes > 0 &&
		sourcemapBucket.bytes / input.downloadBytes >= 0.2
	) {
		recommendations.push(
			"Sourcemaps contribute significant churn bytes. Consider excluding maps from deploy sync if production debugging allows.",
		)
	}

	if (
		input.unknownOwnerBytes > 0 &&
		input.downloadBytes > 0 &&
		input.unknownOwnerBytes / input.downloadBytes >= 0.1
	) {
		recommendations.push(
			"A notable share of churn is unowned. Improve owner grouping rules to make diagnostics more actionable.",
		)
	}

	return recommendations
}

export function churnError(code: TChurnErrorCode, message: string): Error {
	const error = new Error(message)
	error.cause = code
	return error
}
