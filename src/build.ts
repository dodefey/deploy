// See docs/specs/build-module-spec.md for the complete specification of this module.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import * as path from "node:path"
import type { TInteractiveSpawn } from "./interactiveSpawn.js"

export type TBuildOutputMode = "inherit" | "silent" | "callbacks"

export interface TBuildCommand {
	command: string
	args: string[]
}

export interface TBuildOptions {
	rootDir?: string
	env?: Record<string, string>
	outputMode?: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
	onStdoutChunk?: (chunk: string) => void
	onStderrChunk?: (chunk: string) => void
	interactiveSpawn?: TInteractiveSpawn
}

export type TBuildErrorCode =
	| "BUILD_COMMAND_NOT_FOUND"
	| "BUILD_FAILED"
	| "BUILD_INTERRUPTED"

type TSpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess

// Internal test-only option to override spawn; not part of the public API surface.
type TBuildOptionsWithSpawn = TBuildOptions & { spawnImpl?: TSpawnLike }

export async function runBuild(
	commandSpec: TBuildCommand,
	options: TBuildOptions = {},
): Promise<void> {
	const optionsWithSpawn = options as TBuildOptionsWithSpawn
	const {
		rootDir = process.cwd(),
		env = {},
		outputMode = "inherit",
		onStdoutLine,
		onStderrLine,
		onStdoutChunk,
		onStderrChunk,
		interactiveSpawn,
	} = optionsWithSpawn

	const cwd = path.resolve(rootDir)
	const spawnEnv = { ...process.env, ...env }
	if (interactiveSpawn && outputMode === "callbacks") {
		const onOutput = createCombinedOutputForwarder({
			onStdoutLine,
			onStderrLine,
			onStdoutChunk,
			onStderrChunk,
		})

		try {
			const result = await interactiveSpawn({
				command: commandSpec.command,
				args: commandSpec.args,
				cwd,
				env: spawnEnv,
				onOutput,
			})
			if (result.code === 0) return
			if (result.signal) {
				throw buildError(
					"BUILD_INTERRUPTED",
					`Build interrupted by signal: ${result.signal}`,
				)
			}
			throw buildError(
				"BUILD_FAILED",
				`Build failed with exit code ${String(result.code)}`,
			)
		} catch (err) {
			if (err instanceof Error && typeof err.cause === "string") throw err
			const code = (err as NodeJS.ErrnoException | undefined)?.code
			if (code === "ENOENT") {
				throw buildError(
					"BUILD_COMMAND_NOT_FOUND",
					`Build command not found: ${commandSpec.command}`,
				)
			}
			throw buildError(
				"BUILD_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	}

	const stdio = resolveStdio(outputMode)
	const child = createSpawn(optionsWithSpawn)(
		commandSpec.command,
		commandSpec.args,
		{
			cwd,
			env: spawnEnv,
			stdio,
		},
	)

	wireOutput(child, outputMode, {
		onStdoutLine,
		onStderrLine,
		onStdoutChunk,
		onStderrChunk,
	})

	await new Promise<void>((resolve, reject) => {
		child.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				reject(
					buildError(
						"BUILD_COMMAND_NOT_FOUND",
						`Build command not found: ${commandSpec.command}`,
					),
				)
				return
			}
			reject(
				buildError(
					"BUILD_FAILED",
					err instanceof Error ? err.message : String(err),
				),
			)
		})

		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve()
				return
			}
			if (signal) {
				reject(
					buildError(
						"BUILD_INTERRUPTED",
						`Build interrupted by signal: ${signal}`,
					),
				)
				return
			}
			reject(
				buildError(
					"BUILD_FAILED",
					`Build failed with exit code ${String(code)}`,
				),
			)
		})
	})
}

function resolveStdio(outputMode: TBuildOutputMode): SpawnOptions["stdio"] {
	if (outputMode === "silent") {
		return ["ignore", "ignore", "ignore"]
	}
	if (outputMode === "callbacks") {
		return ["ignore", "pipe", "pipe"]
	}
	return "inherit"
}

function wireOutput(
	child: ChildProcess,
	outputMode: TBuildOutputMode,
	listeners: {
		onStdoutLine?: (line: string) => void
		onStderrLine?: (line: string) => void
		onStdoutChunk?: (chunk: string) => void
		onStderrChunk?: (chunk: string) => void
	},
) {
	if (outputMode !== "callbacks") return

	if (listeners.onStdoutChunk || listeners.onStderrChunk) {
		child.stdout?.on("data", (chunk) => {
			listeners.onStdoutChunk?.(String(chunk))
		})
		child.stderr?.on("data", (chunk) => {
			listeners.onStderrChunk?.(String(chunk))
		})
		return
	}

	let stdoutBuffer = ""
	let stderrBuffer = ""

	child.stdout?.on("data", (chunk) => {
		stdoutBuffer += String(chunk)
		stdoutBuffer = flushLines(stdoutBuffer, listeners.onStdoutLine)
	})

	child.stderr?.on("data", (chunk) => {
		stderrBuffer += String(chunk)
		stderrBuffer = flushLines(stderrBuffer, listeners.onStderrLine)
	})

	child.on("close", () => {
		if (stdoutBuffer) {
			flushLines(stdoutBuffer + "\n", listeners.onStdoutLine)
		}
		if (stderrBuffer) {
			flushLines(stderrBuffer + "\n", listeners.onStderrLine)
		}
	})
}

function createCombinedOutputForwarder(listeners: {
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
	onStdoutChunk?: (chunk: string) => void
	onStderrChunk?: (chunk: string) => void
}): (chunk: string) => void {
	if (listeners.onStdoutChunk) return listeners.onStdoutChunk
	if (listeners.onStderrChunk) return listeners.onStderrChunk
	if (listeners.onStdoutLine) return createLineForwarder(listeners.onStdoutLine)
	if (listeners.onStderrLine) return createLineForwarder(listeners.onStderrLine)
	return () => {}
}

function createLineForwarder(onLine: (line: string) => void): (chunk: string) => void {
	let buffer = ""

	return (chunk: string) => {
		buffer += chunk
		buffer = flushLines(buffer, onLine)
	}
}

function flushLines(buffer: string, cb?: (line: string) => void): string {
	if (!cb) return ""
	const lines = buffer.split(/\r?\n/)
	const incomplete = lines.pop() ?? ""
	for (const line of lines) {
		cb(line)
	}
	return incomplete
}

function createSpawn(options: TBuildOptionsWithSpawn): TSpawnLike {
	const custom = options.spawnImpl
	return custom ?? spawn
}

function buildError(code: TBuildErrorCode, message: string): Error {
	const err = new Error(message)
	err.cause = code
	return err
}
