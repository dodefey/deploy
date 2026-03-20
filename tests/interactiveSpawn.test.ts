import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { spawnPtyMock } = vi.hoisted(() => ({
	spawnPtyMock: vi.fn(),
}))

vi.mock("node-pty", () => ({
	spawn: spawnPtyMock,
}))

class FakePtyProcess extends EventEmitter {
	private dataHandlers: Array<(chunk: string) => void> = []
	private exitHandlers: Array<
		(event: { exitCode: number; signal?: number }) => void
	> = []

	resize = vi.fn()

	onData(cb: (chunk: string) => void) {
		this.dataHandlers.push(cb)
		return { dispose: () => {} }
	}

	onExit(cb: (event: { exitCode: number; signal?: number }) => void) {
		this.exitHandlers.push(cb)
		return { dispose: () => {} }
	}

	pushData(chunk: string) {
		for (const cb of this.dataHandlers) cb(chunk)
	}

	pushExit(exitCode: number, signal?: number) {
		for (const cb of this.exitHandlers) cb({ exitCode, signal })
	}
}

describe("interactiveSpawn", () => {
	beforeEach(() => {
		vi.resetModules()
		spawnPtyMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("forwards raw chunks and resolves exit status", async () => {
		const fake = new FakePtyProcess()
		spawnPtyMock.mockReturnValue(fake)
		const { interactiveSpawn } = await import("../src/interactiveSpawn")
		const output: string[] = []

		const promise = interactiveSpawn({
			command: "npx",
			args: ["vitest", "run"],
			cwd: "/tmp/project",
			env: process.env,
			onOutput: (chunk) => output.push(chunk),
		})

		fake.pushData("RUN test\r\n")
		fake.pushData("❯ progress\r\n")
		fake.pushExit(0)

		await expect(promise).resolves.toEqual({ code: 0, signal: null })
		expect(output).toEqual(["RUN test\r\n", "❯ progress\r\n"])
		expect(spawnPtyMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run"],
			expect.objectContaining({ cwd: "/tmp/project" }),
		)
	})

	it("rejects startup failures", async () => {
		spawnPtyMock.mockImplementation(() => {
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
