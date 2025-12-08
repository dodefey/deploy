import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Hoist the mock reference so Vitest's hoisting doesn't evaluate the factory
// before the mock exists.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("child_process", () => ({
	spawn: spawnMock,
}))

import { runTests } from "./../src/test"

class FakeChildProcess extends EventEmitter {
	stdout?: PassThrough
	stderr?: PassThrough
}

describe("runTests", () => {
	beforeEach(() => {
		spawnMock.mockReset()
	})

	it("runs with defaults using inherit stdio", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests()
		queueMicrotask(() => {
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()
		expect(spawnMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run"],
			expect.objectContaining({
				cwd: process.cwd(),
				stdio: "inherit",
			}),
		)
	})

	it("merges env and forwards custom bin/args", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests({
			rootDir: "/repo",
			testBin: "pnpm",
			testArgs: ["test", "--filter", "unit"],
			env: { FOO: "BAR" },
		})
		queueMicrotask(() => {
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()
		expect(spawnMock).toHaveBeenCalledWith(
			"pnpm",
			["test", "--filter", "unit"],
			expect.objectContaining({
				cwd: "/repo",
				env: expect.objectContaining({ FOO: "BAR" }),
				stdio: "inherit",
			}),
		)
	})

	it("uses silent mode stdio", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests({ outputMode: "silent" })
		queueMicrotask(() => {
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()
		expect(spawnMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run"],
			expect.objectContaining({ stdio: "ignore" }),
		)
	})

	it("pipes output and forwards lines in callbacks mode", async () => {
		const child = new FakeChildProcess()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		spawnMock.mockReturnValue(child as any)

		const stdoutLines: string[] = []
		const stderrLines: string[] = []

		const run = runTests({
			outputMode: "callbacks",
			onStdoutLine: (line) => stdoutLines.push(line),
			onStderrLine: (line) => stderrLines.push(line),
		})

		queueMicrotask(() => {
			child.stdout?.write("hello\nworld\r\nlast")
			child.stdout?.end()
			child.stderr?.write("err1\nerr2\n")
			child.stderr?.end()
			child.stdout?.emit("close")
			child.stderr?.emit("close")
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()

		expect(spawnMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run"],
			expect.objectContaining({
				stdio: ["ignore", "pipe", "pipe"],
			}),
		)
		expect(stdoutLines).toEqual(["hello", "world", "last"])
		expect(stderrLines).toEqual(["err1", "err2"])
	})

	it("maps ENOENT to TEST_COMMAND_NOT_FOUND", async () => {
		const err: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), {
			code: "ENOENT",
		})
		spawnMock.mockImplementation(() => {
			throw err
		})

		await expect(
			runTests({ testBin: "missing-cmd" }),
		).rejects.toMatchObject({
			cause: "TEST_COMMAND_NOT_FOUND",
		})
	})

	it("maps non-zero exit to TEST_FAILED", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests()
		queueMicrotask(() => {
			child.emit("exit", 1, null)
			child.emit("close")
		})

		await expect(run).rejects.toMatchObject({ cause: "TEST_FAILED" })
	})

	it("maps signal exit to TEST_INTERRUPTED", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests()
		queueMicrotask(() => {
			child.emit("exit", null, "SIGTERM")
			child.emit("close")
		})

		await expect(run).rejects.toMatchObject({ cause: "TEST_INTERRUPTED" })
	})

	it("maps child 'error' ENOENT to TEST_COMMAND_NOT_FOUND", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests({ testBin: "missing-cmd" })
		queueMicrotask(() => {
			child.emit(
				"error",
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			)
		})

		await expect(run).rejects.toMatchObject({
			cause: "TEST_COMMAND_NOT_FOUND",
		})
	})

	it("maps child 'error' generic to TEST_FAILED", async () => {
		const child = new FakeChildProcess()
		spawnMock.mockReturnValue(child as any)

		const run = runTests()
		queueMicrotask(() => {
			child.emit("error", new Error("boom"))
		})

		await expect(run).rejects.toMatchObject({ cause: "TEST_FAILED" })
	})

	it("callbacks mode works with only stdout callback", async () => {
		const child = new FakeChildProcess()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		spawnMock.mockReturnValue(child as any)

		const stdoutLines: string[] = []

		const run = runTests({
			outputMode: "callbacks",
			onStdoutLine: (line) => stdoutLines.push(line),
		})

		queueMicrotask(() => {
			child.stdout?.write("only-stdout")
			child.stdout?.end()
			child.stderr?.write("ignored")
			child.stderr?.end()
			child.stdout?.emit("close")
			child.stderr?.emit("close")
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()
		expect(stdoutLines).toEqual(["only-stdout"])
	})

	it("callbacks mode works with no callbacks provided", async () => {
		const child = new FakeChildProcess()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		spawnMock.mockReturnValue(child as any)

		const run = runTests({ outputMode: "callbacks" })

		queueMicrotask(() => {
			child.stdout?.write("noop")
			child.stderr?.write("noop")
			child.stdout?.end()
			child.stderr?.end()
			child.stdout?.emit("close")
			child.stderr?.emit("close")
			child.emit("exit", 0, null)
			child.emit("close")
		})

		await expect(run).resolves.toBeUndefined()
	})
})
