import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

const CLIENT_SUBDIR = "public/_nuxt"
const CLIENT_MANIFEST_NAME = "manifest"

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

export function normalizeManifestPath(
	baseDir: string,
	absolutePath: string,
): string {
	const relativePath = path.relative(baseDir, absolutePath)
	return "./" + relativePath.split(path.sep).join("/")
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
