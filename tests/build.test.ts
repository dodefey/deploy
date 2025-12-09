import type { SpawnOptions } from "node:child_process"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runBuild } from "../src/build"
import {
	createAdvancedMockChildProcess,
	type IAdvancedMockChildProcess,
} from "./mockChildProcess"

type TSpawnCall = {
	command: string
	args: string[]
	options: SpawnOptions
}

type TSpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => any

type TTestBuildOptions = NonNullable<Parameters<typeof runBuild>[1]> & {
	spawnImpl: TSpawnLike
}

const withSpawn = (options: TTestBuildOptions) =>
	options as Parameters<typeof runBuild>[1]

const commandSpec = { command: "custom", args: ["build"] }

afterEach(() => {
	vi.restoreAllMocks()
})

function makeSpawnMocks() {
	const calls: TSpawnCall[] = []
	let child: IAdvancedMockChildProcess | null = null
	const requireChild = () => {
		if (!child) {
			throw new Error("spawn not invoked before emit")
		}
		return child
	}

	const spawnImpl = vi.fn((command: string, args: string[], options: any) => {
		calls.push({ command, args, options })
		child = createAdvancedMockChildProcess()
		return child
	})

	const emitClose = (
		code: number | null,
		signal: NodeJS.Signals | null = null,
	) => {
		requireChild().emit("close", code, signal)
	}
	const emitError = (err: any) => {
		requireChild().emit("error", err)
	}
	const emitStdout = (data: string) => {
		requireChild().pushStdout(data)
	}
	const emitStderr = (data: string) => {
		requireChild().pushStderr(data)
	}

	return { spawnImpl, calls, emitClose, emitError, emitStdout, emitStderr }
}

describe("runBuild happy paths", () => {
	it("resolves on successful close", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()

		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})

	it("wires provided command, cwd, env, stdio defaults", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			{ command: "pnpm", args: ["run", "build"] },
			withSpawn({
				spawnImpl,
				env: { TEST_EXTRA: "1" },
			}),
		)
		emitClose(0, null)
		await promise

		expect(calls).toHaveLength(1)
		const call = calls[0]!
		expect(call.command).toBe("pnpm")
		expect(call.args).toEqual(["run", "build"])
		expect(call.options.cwd).toBe(resolve(process.cwd()))
		expect((call.options.env as Record<string, string>).TEST_EXTRA).toBe(
			"1",
		)
		expect(call.options.stdio).toBe("inherit")
	})
})

describe("runBuild error mapping", () => {
	it("maps ENOENT to BUILD_COMMAND_NOT_FOUND", async () => {
		const { spawnImpl, emitError } = makeSpawnMocks()
		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitError({ code: "ENOENT" })
		await expect(promise).rejects.toMatchObject({
			cause: "BUILD_COMMAND_NOT_FOUND",
		})
	})

	it("maps generic spawn error to BUILD_FAILED", async () => {
		const { spawnImpl, emitError } = makeSpawnMocks()
		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitError(new Error("boom"))
		await expect(promise).rejects.toMatchObject({ cause: "BUILD_FAILED" })
	})

	it("maps non-zero exit code to BUILD_FAILED", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()
		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitClose(1, null)
		await expect(promise).rejects.toMatchObject({ cause: "BUILD_FAILED" })
	})

	it("maps signal to BUILD_INTERRUPTED", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()
		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitClose(null, "SIGINT")
		await expect(promise).rejects.toMatchObject({
			cause: "BUILD_INTERRUPTED",
		})
	})
})

describe("output mode wiring", () => {
	it("inherit mode uses stdio inherit", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "inherit",
			}),
		)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toBe("inherit")
	})

	it("silent mode ignores stdio", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "silent",
			}),
		)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toEqual(["ignore", "ignore", "ignore"])
	})

	it("callbacks mode pipes stdio", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "callbacks",
			}),
		)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toEqual(["ignore", "pipe", "pipe"])
	})

	it("splits stdout lines and flushes trailing partial", async () => {
		const { spawnImpl, emitStdout, emitClose } = makeSpawnMocks()
		const lines: string[] = []
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "callbacks",
				onStdoutLine: (line: string) => lines.push(line),
			}),
		)
		emitStdout("foo\nbar")
		emitStdout("\nbaz\n")
		emitStdout("partial")
		emitClose(0, null)
		await promise
		expect(lines).toEqual(["foo", "bar", "baz", "partial"])
	})

	it("splits stderr lines", async () => {
		const { spawnImpl, emitStderr, emitClose } = makeSpawnMocks()
		const lines: string[] = []
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "callbacks",
				onStderrLine: (line: string) => lines.push(line),
			}),
		)
		emitStderr("oops\nbad")
		emitClose(0, null)
		await promise
		expect(lines).toEqual(["oops", "bad"])
	})
})

describe("missing callback behavior", () => {
	it("ignores stderr when only stdout callback provided", async () => {
		const { spawnImpl, emitStderr, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "callbacks",
				onStdoutLine: () => {},
			}),
		)
		emitStderr("ignore me\n")
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})

	it("handles no callbacks provided", async () => {
		const { spawnImpl, emitStdout, emitStderr, emitClose } =
			makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				outputMode: "callbacks",
			}),
		)
		emitStdout("foo\n")
		emitStderr("bar\n")
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})
})

describe("spawn injection", () => {
	it("uses spawnImpl when provided", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(commandSpec, withSpawn({ spawnImpl }))
		emitClose(0, null)
		await promise
		expect(spawnImpl).toHaveBeenCalledTimes(1)
		expect(calls).toHaveLength(1)
	})

	it("falls back to real spawn when spawnImpl is not provided", async () => {
		vi.resetModules()
		const child = createAdvancedMockChildProcess()
		const spawnMock = vi.fn().mockReturnValue(child)
		vi.doMock("node:child_process", () => ({ spawn: spawnMock }))
		const { runBuild: runBuildWithMock } = await import("../src/build")

		const promise = runBuildWithMock({ command: "npx", args: ["build"] })
		child.triggerClose(0, null)
		await promise

		expect(spawnMock).toHaveBeenCalledTimes(1)
	})
})

describe("option wiring", () => {
	it("applies rootDir override", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runBuild(
			commandSpec,
			withSpawn({
				spawnImpl,
				rootDir: "/tmp/project",
			}),
		)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.cwd).toBe(resolve("/tmp/project"))
	})
})
