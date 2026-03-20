import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}))

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}))

class FakeChildProcess extends EventEmitter {
	stdout = new PassThrough()
	stderr = new PassThrough()
}

describe("interactiveSpawn", () => {
	beforeEach(() => {
		vi.resetModules()
		spawnMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("forwards raw chunks, strips script prefix noise, and resolves exit status", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)
		const { interactiveSpawn } = await import("../src/interactiveSpawn")
		const output: string[] = []

		const promise = interactiveSpawn({
			command: "npx",
			args: ["vitest", "run"],
			cwd: "/tmp/project",
			env: process.env,
			onOutput: (chunk) => output.push(chunk),
		})

		queueMicrotask(() => {
			child.stdout.write("^D\b\bRUN test\r\n")
			child.stdout.write("❯ progress\r\n")
			child.stderr.write("warn\r\n")
			child.emit("close", 0, null)
		})

		await expect(promise).resolves.toEqual({ code: 0, signal: null })
		expect(output).toEqual(["RUN test\r\n", "❯ progress\r\n", "warn\r\n"])
		expect(spawnMock).toHaveBeenCalledWith(
			"script",
			["-q", "/dev/null", "npx", "vitest", "run"],
			expect.objectContaining({ cwd: "/tmp/project" }),
		)
	})

	it("rejects startup failures", async () => {
		spawnMock.mockImplementation(() => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" })
		})
		const { interactiveSpawn } = await import("../src/interactiveSpawn")

		await expect(
			interactiveSpawn({
				command: "missing",
				args: [],
				cwd: "/tmp/project",
				env: process.env,
				onOutput: () => {},
			}),
		).rejects.toMatchObject({ message: "missing" })
	})
})
