import type { ChildProcess, SpawnOptions } from "child_process"
import { spawn } from "child_process"

export type TTestOutputMode = "inherit" | "silent" | "callbacks"

export interface TTestOptions {
	// Base directory where the project lives; defaults to process.cwd()
	rootDir?: string

	// How to invoke the test runner; default is equivalent to `npm test`
	testBin?: string
	testArgs?: string[]

	// Extra env to merge into process.env when spawning the tests
	env?: Record<string, string>

	// How to handle test output
	// "inherit"   -> test output goes directly to parent stdio
	// "silent"    -> test stdout/stderr are ignored
	// "callbacks" -> test stdout/stderr are piped and forwarded line-by-line
	outputMode?: TTestOutputMode

	// Optional callbacks when outputMode === "callbacks"
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export type TTestErrorCode =
	| "TEST_COMMAND_NOT_FOUND"
	| "TEST_FAILED"
	| "TEST_INTERRUPTED"

type TSpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess

interface TResolvedTestOptions {
	rootDir: string
	testBin: string
	testArgs: string[]
	env: NodeJS.ProcessEnv
	outputMode: TTestOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

/**
 * Public entrypoint: run the test suite according to the spec.
 *
 * On success, resolves void.
 * On failure, rejects with an Error whose `cause` is a TTestErrorCode.
 */
export async function runTests(options: TTestOptions = {}): Promise<void> {
	const resolved = resolveOptions(options)
	const spawnImpl = getSpawnImplementation()

	await runTestsWithSpawn(resolved, spawnImpl)
}

// ---- Internal helpers below ----

function resolveOptions(options: TTestOptions): TResolvedTestOptions {
	const rootDir = options.rootDir?.trim() || process.cwd()
	const testBin = options.testBin?.trim() || "npx"
	const testArgs =
		options.testArgs && options.testArgs.length > 0
			? options.testArgs
			: ["vitest", "run"]

	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(options.env ?? {}),
	}

	const outputMode: TTestOutputMode = options.outputMode ?? "inherit"

	return {
		rootDir,
		testBin,
		testArgs,
		env,
		outputMode,
		onStdoutLine: options.onStdoutLine,
		onStderrLine: options.onStderrLine,
	}
}

function getSpawnImplementation(): TSpawnLike {
	return spawn
}

function runTestsWithSpawn(
	options: TResolvedTestOptions,
	spawnImpl: TSpawnLike,
): Promise<void> {
	const spawnOptions = buildSpawnOptions(options)

	return new Promise((resolve, reject) => {
		let child: ChildProcess
		let exitCode: number | null = null
		let exitSignal: NodeJS.Signals | null = null

		try {
			child = spawnImpl(options.testBin, options.testArgs, spawnOptions)
		} catch (err) {
			// Synchronous spawn errors are treated like TEST_FAILED,
			// unless they are clearly ENOENT.
			const code = (err as NodeJS.ErrnoException | undefined)?.code
			if (code === "ENOENT") {
				reject(
					testError(
						"TEST_COMMAND_NOT_FOUND",
						`Test command "${options.testBin}" was not found in PATH.`,
					),
				)
			} else {
				reject(
					testError(
						"TEST_FAILED",
						`Failed to start test command "${options.testBin}".`,
					),
				)
			}
			return
		}

		wireChildOutput(child, options)

		child.on("error", (err: NodeJS.ErrnoException) => {
			const code = err.code
			if (code === "ENOENT") {
				reject(
					testError(
						"TEST_COMMAND_NOT_FOUND",
						`Test command "${options.testBin}" was not found in PATH.`,
					),
				)
			} else {
				reject(
					testError(
						"TEST_FAILED",
						`Failed to start test command "${options.testBin}".`,
					),
				)
			}
		})

		child.on(
			"exit",
			(code: number | null, signal: NodeJS.Signals | null) => {
				exitCode = code
				exitSignal = signal
			},
		)

		child.on("close", () => {
			if (exitSignal) {
				reject(
					testError(
						"TEST_INTERRUPTED",
						`Test process was interrupted by signal ${exitSignal}.`,
					),
				)
				return
			}

			if (exitCode === 0) {
				resolve()
				return
			}

			reject(
				testError(
					"TEST_FAILED",
					`Test process exited with code ${String(exitCode)}.`,
				),
			)
		})
	})
}

function buildSpawnOptions(options: TResolvedTestOptions): SpawnOptions {
	const base: SpawnOptions = {
		cwd: options.rootDir,
		env: options.env,
	}

	switch (options.outputMode) {
		case "inherit":
			return { ...base, stdio: "inherit" }
		case "silent":
			return { ...base, stdio: "ignore" }
		case "callbacks":
			// We need stdout/stderr as streams for callbacks.
			return { ...base, stdio: ["ignore", "pipe", "pipe"] }
	}
}

function wireChildOutput(
	child: ChildProcess,
	options: TResolvedTestOptions,
): void {
	if (options.outputMode !== "callbacks") {
		// In "inherit" and "silent" modes, we let stdio configuration handle output.
		return
	}

	if (child.stdout && options.onStdoutLine) {
		forwardStreamByLine(child.stdout, options.onStdoutLine)
	}

	if (child.stderr && options.onStderrLine) {
		forwardStreamByLine(child.stderr, options.onStderrLine)
	}
}

function forwardStreamByLine(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): void {
	let buffer = ""

	stream.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString("utf8")

		let newlineIndex: number
		// Emit complete lines one by one
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).replace(/\r$/, "")
			buffer = buffer.slice(newlineIndex + 1)
			if (line.length > 0) {
				onLine(line)
			}
		}
	})

	stream.on("end", () => {
		emitFinalBuffer()
	})

	stream.on("close", () => {
		emitFinalBuffer()
	})

	function emitFinalBuffer() {
		const final = buffer.trim()
		if (final.length > 0) {
			onLine(final)
		}
		buffer = ""
	}
}

function testError(code: TTestErrorCode, message: string): Error {
	const err = new Error(message)
	err.cause = code
	return err
}
