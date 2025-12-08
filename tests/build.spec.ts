import type { SpawnOptions } from "node:child_process"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runNuxtBuild } from "../src/build"
import {
	createAdvancedMockChildProcess,
	type IAdvancedMockChildProcess,
} from "./mockChildProcess"

type TSpawnCall = {
	command: string
	args: string[]
	options: SpawnOptions
}

type TBuildOptionsWithSpawn = Parameters<typeof runNuxtBuild>[0] & {
	spawnImpl?: (...args: any[]) => any
}

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

describe("runNuxtBuild happy paths", () => {
	it("resolves on successful close with defaults", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()

		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})

	it("wires defaults for command, args, cwd, env, stdio", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			env: { TEST_EXTRA: "1" },
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise

		expect(calls).toHaveLength(1)
		const call = calls[0]!
		expect(call.command).toBe("npx")
		expect(call.args).toEqual([
			"nuxt",
			"build",
			"--dotenv",
			".env.production",
		])
		expect(call.options.cwd).toBe(resolve(process.cwd()))
		expect((call.options.env as Record<string, string>).TEST_EXTRA).toBe(
			"1",
		)
		expect(call.options.stdio).toBe("inherit")
	})
})

describe("runNuxtBuild error mapping", () => {
	it("maps ENOENT to BUILD_COMMAND_NOT_FOUND", async () => {
		const { spawnImpl, emitError } = makeSpawnMocks()
		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
		emitError({ code: "ENOENT" })
		await expect(promise).rejects.toMatchObject({
			cause: "BUILD_COMMAND_NOT_FOUND",
		})
	})

	it("maps generic spawn error to BUILD_FAILED", async () => {
		const { spawnImpl, emitError } = makeSpawnMocks()
		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
		emitError(new Error("boom"))
		await expect(promise).rejects.toMatchObject({ cause: "BUILD_FAILED" })
	})

	it("maps non-zero exit code to BUILD_FAILED", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
		emitClose(1, null)
		await expect(promise).rejects.toMatchObject({ cause: "BUILD_FAILED" })
	})

	it("maps signal to BUILD_INTERRUPTED", async () => {
		const { spawnImpl, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
		emitClose(null, "SIGINT")
		await expect(promise).rejects.toMatchObject({
			cause: "BUILD_INTERRUPTED",
		})
	})
})

describe("output mode wiring", () => {
	it("inherit mode uses stdio inherit", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "inherit",
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toBe("inherit")
	})

	it("silent mode ignores stdio", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "silent",
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toEqual(["ignore", "ignore", "ignore"])
	})

	it("callbacks mode pipes stdio", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "callbacks",
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.stdio).toEqual(["ignore", "pipe", "pipe"])
	})

	it("splits stdout lines and flushes trailing partial", async () => {
		const { spawnImpl, emitStdout, emitClose } = makeSpawnMocks()
		const lines: string[] = []
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "callbacks",
			onStdoutLine: (line) => lines.push(line),
		} as TBuildOptionsWithSpawn)
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
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "callbacks",
			onStderrLine: (line) => lines.push(line),
		} as TBuildOptionsWithSpawn)
		emitStderr("oops\nbad")
		emitClose(0, null)
		await promise
		expect(lines).toEqual(["oops", "bad"])
	})
})

describe("missing callback behavior", () => {
	it("ignores stderr when only stdout callback provided", async () => {
		const { spawnImpl, emitStderr, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "callbacks",
			onStdoutLine: () => {},
		} as TBuildOptionsWithSpawn)
		emitStderr("ignore me\n")
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})

	it("handles no callbacks provided", async () => {
		const { spawnImpl, emitStdout, emitStderr, emitClose } =
			makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			outputMode: "callbacks",
		} as TBuildOptionsWithSpawn)
		emitStdout("foo\n")
		emitStderr("bar\n")
		emitClose(0, null)
		await expect(promise).resolves.toBeUndefined()
	})
})

describe("spawn injection", () => {
	it("uses spawnImpl when provided", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({ spawnImpl } as TBuildOptionsWithSpawn)
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
		const { runNuxtBuild: runNuxtBuildWithMock } =
			await import("./../src/build")

		const promise = runNuxtBuildWithMock()
		child.triggerClose(0, null)
		await promise

		expect(spawnMock).toHaveBeenCalledTimes(1)
	})
})

describe("option wiring", () => {
	it("applies rootDir override", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			rootDir: "/tmp/project",
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise
		expect(calls[0]!.options.cwd).toBe(resolve("/tmp/project"))
	})

	it("applies nuxtBin and nuxtArgs overrides", async () => {
		const { spawnImpl, calls, emitClose } = makeSpawnMocks()
		const promise = runNuxtBuild({
			spawnImpl,
			nuxtBin: "custom",
			nuxtArgs: ["nuxt", "build", "--dotenv", ".env.test"],
		} as TBuildOptionsWithSpawn)
		emitClose(0, null)
		await promise
		expect(calls[0]!.command).toBe("custom")
		expect(calls[0]!.args).toEqual([
			"nuxt",
			"build",
			"--dotenv",
			".env.test",
		])
	})
})
