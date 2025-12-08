import { spawn, type SpawnOptions } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import type { TBuildOutputMode } from "./build.ts"

export interface TSyncBuildOptions {
	sshConnectionString: string
	remoteDir: string
	localOutputDir?: string
	dryRun?: boolean
	outputMode?: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export type TSyncBuildErrorCode =
	| "SYNC_NO_LOCAL_OUTPUT_DIR"
	| "SYNC_SSH_FAILED"
	| "SYNC_RSYNC_FAILED"

type TRunOptions = {
	outputMode: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

type TRunResult = {
	code: number | null
	stdout: string
	stderr: string
	spawnError?: string
}

export async function syncBuild(options: TSyncBuildOptions): Promise<void> {
	const {
		sshConnectionString,
		remoteDir,
		localOutputDir = ".output",
		dryRun = false,
		outputMode = "inherit",
		onStdoutLine,
		onStderrLine,
	} = options

	const runOptions: TRunOptions = { outputMode, onStdoutLine, onStderrLine }
	const localDir = resolveLocalDir(localOutputDir)

	await ensureLocalOutputDir(localDir)

	const remoteTarget = path.posix.join(remoteDir, ".output")

	if (!dryRun) {
		await ensureRemoteDir(sshConnectionString, remoteTarget, runOptions)
	}

	await runRsync(
		sshConnectionString,
		localDir,
		remoteTarget,
		dryRun,
		runOptions,
	)
}

function resolveLocalDir(dir: string): string {
	return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

async function ensureLocalOutputDir(dir: string): Promise<void> {
	try {
		const stat = await fs.stat(dir)
		if (!stat.isDirectory()) {
			throw syncError(
				"SYNC_NO_LOCAL_OUTPUT_DIR",
				`Local output directory is not a directory: ${dir}`,
			)
		}
	} catch (err) {
		if (err instanceof Error && err.cause === "SYNC_NO_LOCAL_OUTPUT_DIR") {
			throw err
		}
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw syncError(
				"SYNC_NO_LOCAL_OUTPUT_DIR",
				`Local output directory does not exist: ${dir}`,
			)
		}
		throw syncError(
			"SYNC_NO_LOCAL_OUTPUT_DIR",
			err instanceof Error ? err.message : String(err),
		)
	}
}

async function ensureRemoteDir(
	sshConnectionString: string,
	remoteDir: string,
	runOptions: TRunOptions,
): Promise<void> {
	const quotedDir = shellQuoteSingle(remoteDir)
	const result = await runCommand(
		"ssh",
		[sshConnectionString, `mkdir -p ${quotedDir}`],
		runOptions,
	)

	if (result.spawnError) {
		throw syncError("SYNC_SSH_FAILED", result.spawnError)
	}
	if (result.code !== 0) {
		const codeString = String(result.code)
		throw syncError(
			"SYNC_SSH_FAILED",
			result.stderr || `ssh exited with code ${codeString}`,
		)
	}
}

async function runRsync(
	sshConnectionString: string,
	localDir: string,
	remoteDir: string,
	dryRun: boolean,
	runOptions: TRunOptions,
): Promise<void> {
	const source = addTrailingSlash(localDir)
	const remotePath = addTrailingSlashPosix(remoteDir)
	const target = `${sshConnectionString}:${remotePath}`

	const args = ["-a", "-z", "--delete", "--timeout=60", "-e", "ssh"]

	if (dryRun) {
		args.push("--dry-run")
	}

	args.push(source, target)

	const result = await runCommand("rsync", args, runOptions)

	if (result.spawnError) {
		throw syncError("SYNC_RSYNC_FAILED", result.spawnError)
	}
	if (result.code !== 0) {
		const codeString = String(result.code)
		throw syncError(
			"SYNC_RSYNC_FAILED",
			result.stderr || `rsync exited with code ${codeString}`,
		)
	}
}

function addTrailingSlash(dir: string): string {
	return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`
}

function addTrailingSlashPosix(dir: string): string {
	const normalized = dir.endsWith("/") ? dir : `${dir}/`
	return normalized
}

function runCommand(
	command: string,
	args: string[],
	runOptions: TRunOptions,
): Promise<TRunResult> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let spawnError: string | undefined
		let resolved = false

		const finish = (result: TRunResult) => {
			if (resolved) return
			resolved = true
			resolve(result)
		}

		const stdio = resolveStdio(runOptions.outputMode)
		const child = spawn(command, args, { stdio } as SpawnOptions)

		if (runOptions.outputMode === "callbacks") {
			wireCallbacks(
				child,
				runOptions,
				(chunk) => {
					stdout += chunk
				},
				(chunk) => {
					stderr += chunk
				},
			)
		} else if (stdio !== "inherit") {
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk)
			})
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk)
			})
		} else {
			child.stdout?.on("data", (chunk) => {
				const text = String(chunk)
				stdout += text
			})
			child.stderr?.on("data", (chunk) => {
				const text = String(chunk)
				stderr += text
			})
		}

		child.on("error", (err) => {
			spawnError = err instanceof Error ? err.message : String(err)
			stderr += spawnError
			finish({ code: 1, stdout, stderr, spawnError })
		})

		child.on("close", (code) => {
			finish({ code, stdout, stderr, spawnError })
		})
	})
}

function wireCallbacks(
	child: ReturnType<typeof spawn>,
	runOptions: TRunOptions,
	onStdout: (chunk: string) => void,
	onStderr: (chunk: string) => void,
) {
	let stdoutBuffer = ""
	let stderrBuffer = ""

	child.stdout?.on("data", (chunk) => {
		const text = String(chunk)
		if (!runOptions.onStdoutLine) {
			onStdout(text)
			return
		}
		stdoutBuffer += text
		stdoutBuffer = flushLines(
			stdoutBuffer,
			runOptions.onStdoutLine,
			onStdout,
		)
	})

	child.stderr?.on("data", (chunk) => {
		const text = String(chunk)
		if (!runOptions.onStderrLine) {
			onStderr(text)
			return
		}
		stderrBuffer += text
		stderrBuffer = flushLines(
			stderrBuffer,
			runOptions.onStderrLine,
			onStderr,
		)
	})

	child.on("close", () => {
		if (stdoutBuffer) {
			flushLines(stdoutBuffer + "\n", runOptions.onStdoutLine, onStdout)
		}
		if (stderrBuffer) {
			flushLines(stderrBuffer + "\n", runOptions.onStderrLine, onStderr)
		}
	})
}

function flushLines(
	buffer: string,
	cb: ((line: string) => void) | undefined,
	collect: (chunk: string) => void,
): string {
	if (!cb) return ""
	const lines = buffer.split(/\r?\n/)
	const incomplete = lines.pop() ?? ""
	for (const line of lines) {
		cb(line)
		collect(line + "\n")
	}
	return incomplete
}

function resolveStdio(
	outputMode: TBuildOutputMode,
): "inherit" | ["ignore", "ignore", "ignore"] | ["ignore", "pipe", "pipe"] {
	if (outputMode === "silent") return ["ignore", "ignore", "ignore"]
	if (outputMode === "callbacks") return ["ignore", "pipe", "pipe"]
	return "inherit"
}

function shellQuoteSingle(value: string): string {
	return "'" + value.replace(/'/g, `'"'"'`) + "'"
}

function syncError(code: TSyncBuildErrorCode, message: string): Error {
	const err = new Error(message)
	err.cause = code
	return err
}
