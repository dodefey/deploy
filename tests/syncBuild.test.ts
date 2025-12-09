import type { ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

type TSpawnResponse = {
	stdout?: string
	stderr?: string
	code?: number | null
	error?: Error
}

type TSpawnCall = {
	command: string
	args: string[]
}

function makeSpawnMock(responses: TSpawnResponse[]) {
	const calls: TSpawnCall[] = []
	const spawnMock = vi.fn((command: string, args: string[]) => {
		const child: Partial<ChildProcess> =
			new PassThrough() as unknown as ChildProcess
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		calls.push({ command, args })

		const response = responses.shift() ?? {}
		queueMicrotask(() => {
			if (response.error) {
				child.emit?.("error", response.error)
				child.emit?.("close", 1)
				return
			}
			if (response.stdout) child.stdout?.emit("data", response.stdout)
			if (response.stderr) child.stderr?.emit("data", response.stderr)
			child.emit?.("close", response.code ?? 0)
		})

		return child as ChildProcess
	})

	return { spawnMock, calls }
}

afterEach(() => {
	vi.resetModules()
	vi.restoreAllMocks()
})

async function importModuleWithMocks(
	responses: TSpawnResponse[],
	localConfig?: { exists?: boolean; isDir?: boolean },
) {
	const { spawnMock, calls } = makeSpawnMock(responses)
	const statMock = vi.fn()
	if (localConfig?.exists === false) {
		statMock.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		)
	} else if (localConfig?.isDir === false) {
		statMock.mockResolvedValue({ isDirectory: () => false })
	} else {
		statMock.mockResolvedValue({ isDirectory: () => true })
	}

	vi.doMock("node:child_process", () => ({ spawn: spawnMock }))
	vi.doMock("node:fs", () => ({
		promises: {
			stat: statMock,
		},
	}))

	const { syncBuild } = await import("../src/syncBuild")
	return { syncBuild, calls, statMock }
}

describe("syncBuild", () => {
	it("throws when local output dir is missing", async () => {
		const { syncBuild } = await importModuleWithMocks([], { exists: false })
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({ cause: "SYNC_NO_LOCAL_OUTPUT_DIR" })
	})

	it("validates local output dir even when dryRun is true", async () => {
		const { syncBuild } = await importModuleWithMocks([], { exists: false })
		await expect(
			syncBuild({
				sshConnectionString: "h",
				remoteDir: "/app",
				dryRun: true,
			}),
		).rejects.toMatchObject({ cause: "SYNC_NO_LOCAL_OUTPUT_DIR" })
	})

	it("throws when local output dir is not a directory", async () => {
		const { syncBuild } = await importModuleWithMocks([], { isDir: false })
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({ cause: "SYNC_NO_LOCAL_OUTPUT_DIR" })
	})

	it("runs ssh mkdir then rsync on success", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // ssh mkdir
			{ code: 0 }, // rsync
		]
		const { syncBuild, calls } = await importModuleWithMocks(responses)
		await syncBuild({ sshConnectionString: "h", remoteDir: "/app" })

		expect(calls).toHaveLength(2)
		expect(calls[0]).toMatchObject({ command: "ssh" })
		expect(calls[1]).toMatchObject({ command: "rsync" })
		expect(calls[0]?.args.join(" ")).toContain("mkdir -p '/app/.output'")
	})

	it("builds rsync args with required flags and paths", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // ssh mkdir
			{ code: 0 }, // rsync
		]
		const { syncBuild, calls } = await importModuleWithMocks(responses)
		await syncBuild({
			sshConnectionString: "user@host",
			remoteDir: "/remote",
		})

		const rsyncCall = calls.find((c) => c.command === "rsync")
		expect(rsyncCall).toBeDefined()
		expect(rsyncCall?.args).toEqual(
			expect.arrayContaining([
				"-a",
				"-z",
				"--delete",
				"--timeout=60",
				"-e",
				"ssh",
			]),
		)
		const target = rsyncCall?.args?.at(-1) as string
		expect(target).toContain("/remote/.output/")
		expect(target.startsWith("user@host:")).toBe(true)
	})

	it("skips remote mkdir when dryRun is true but still runs rsync with --dry-run", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // rsync
		]
		const { syncBuild, calls } = await importModuleWithMocks(responses)
		await syncBuild({
			sshConnectionString: "h",
			remoteDir: "/app",
			dryRun: true,
		})

		expect(calls).toHaveLength(1)
		expect(calls[0]?.command).toBe("rsync")
		expect(calls[0]?.args).toContain("--dry-run")
	})

	it("maps ssh mkdir failure to SYNC_SSH_FAILED", async () => {
		const responses: TSpawnResponse[] = [{ code: 2, stderr: "perm denied" }]
		const { syncBuild } = await importModuleWithMocks(responses)
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({ cause: "SYNC_SSH_FAILED" })
	})

	it("maps ssh spawn error to SYNC_SSH_FAILED", async () => {
		const responses: TSpawnResponse[] = [{ error: new Error("ssh spawn") }]
		const { syncBuild } = await importModuleWithMocks(responses)
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({
			cause: "SYNC_SSH_FAILED",
		})
	})

	it("maps rsync failure to SYNC_RSYNC_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // mkdir
			{ code: 1, stderr: "rsync error" },
		]
		const { syncBuild } = await importModuleWithMocks(responses)
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({ cause: "SYNC_RSYNC_FAILED" })
	})

	it("maps rsync spawn error to SYNC_RSYNC_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // mkdir
			{ error: new Error("rsync spawn") },
		]
		const { syncBuild } = await importModuleWithMocks(responses)
		await expect(
			syncBuild({ sshConnectionString: "h", remoteDir: "/app" }),
		).rejects.toMatchObject({
			cause: "SYNC_RSYNC_FAILED",
		})
	})

	it("delivers rsync output lines when callbacks are provided", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // mkdir
			{ code: 0, stdout: "line1\nline2\n" }, // rsync
		]
		const { syncBuild } = await importModuleWithMocks(responses)
		const out: string[] = []
		const err: string[] = []
		await syncBuild({
			sshConnectionString: "h",
			remoteDir: "/app",
			outputMode: "callbacks",
			onStdoutLine: (line) => out.push(line),
			onStderrLine: (line) => err.push(line),
		})
		expect(out).toEqual(["line1", "line2"])
		expect(err).toEqual([])
	})

	it("delivers stderr lines to onStderrLine", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // mkdir
			{ code: 0, stderr: "warn1\nwarn2\n" }, // rsync
		]
		const { syncBuild } = await importModuleWithMocks(responses)
		const out: string[] = []
		const err: string[] = []
		await syncBuild({
			sshConnectionString: "h",
			remoteDir: "/app",
			outputMode: "callbacks",
			onStdoutLine: (line) => out.push(line),
			onStderrLine: (line) => err.push(line),
		})
		expect(out).toEqual([])
		expect(err).toEqual(["warn1", "warn2"])
	})
})
