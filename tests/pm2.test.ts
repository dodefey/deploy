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
			if (response.stdout) {
				child.stdout?.emit("data", response.stdout)
			}
			if (response.stderr) {
				child.stderr?.emit("data", response.stderr)
			}
			child.emit?.("close", response.code ?? 0)
		})

		return child as ChildProcess
	})

	return { spawnMock, calls }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.resetModules()
})

async function importModuleWithMocks(
	responses: TSpawnResponse[],
	localConfig = "local",
) {
	const { spawnMock, calls } = makeSpawnMock(responses)

	vi.doMock("node:child_process", () => ({ spawn: spawnMock }))
	vi.doMock("node:fs", () => ({
		promises: {
			readFile: vi.fn().mockResolvedValue(localConfig),
		},
	}))

	const { updatePM2App } = await import("../src/pm2")
	return { updatePM2App, calls }
}

describe("updatePm2App", () => {
	it("uploads when remote is missing and reports configChanged", async () => {
		const responses: TSpawnResponse[] = [
			// test -f missing
			{ code: 1, stderr: "" },
			// upload script
			{ code: 0 },
			// ensurePm2AppExists jlist (app present but stopped)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			},
			// startOrReload
			{ code: 0 },
			// healthcheck jlist (online)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			},
		]

		const { updatePM2App, calls } = await importModuleWithMocks(responses)
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
		})

		expect(result.configChanged).toBe(true)
		expect(result.instanceCount).toBe(1)
		expect(calls[0]?.command).toBe("ssh") // test -f
		expect(calls[1]?.command).toBe("ssh") // upload
	})

	it("skips upload when configs match", async () => {
		const content = "same"
		const responses: TSpawnResponse[] = [
			// test -f exists
			{ code: 0 },
			// cat remote content
			{ code: 0, stdout: content },
			// ensurePm2AppExists jlist (app online)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			},
			// startOrReload
			{ code: 0 },
			// healthcheck jlist (online)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			},
		]

		const { updatePM2App, calls } = await importModuleWithMocks(
			responses,
			content,
		)
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
		})

		expect(result.configChanged).toBe(false)
		// Calls: test -f, cat, ensure, restart, jlist
		expect(calls.length).toBe(5)
	})

	it("throws healthcheck error when pm2 jlist never reports online", async () => {
		const responses: TSpawnResponse[] = [
			// test -f exists
			{ code: 0 },
			// cat remote content
			{ code: 0, stdout: "remote" },
			// ensurePm2AppExists jlist (app present but stopped)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			},
			// startOrReload
			{ code: 0 },
			// pm2 jlist attempt 1
			{ code: 0, stdout: JSON.stringify([]) },
			// pm2 jlist attempt 2
			{ code: 0, stdout: JSON.stringify([]) },
			// pm2 jlist attempt 3
			{ code: 0, stdout: JSON.stringify([]) },
		]

		const { updatePM2App } = await importModuleWithMocks(
			responses,
			"remote",
		)
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_HEALTHCHECK_FAILED" })
	})

	it("honors reboot restart mode and tolerates delete failures", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f exists
			{ code: 0, stdout: "old" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist (app present but stopped)
			{ code: 1, stderr: "not found" }, // pm2 delete (ignored)
			{ code: 0 }, // pm2 start
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // healthcheck jlist (online)
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // additional healthcheck jlist
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "new")
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
			restartMode: "reboot",
		})

		expect(result.configChanged).toBe(true)
		expect(result.instanceCount).toBe(1)
	})

	it("maps pm2 command failure to PM2_COMMAND_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "old" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist (app present but stopped)
			{ code: 2, stderr: "pm2 error" }, // startOrReload
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "new")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_COMMAND_FAILED" })
	})

	it("maps upload spawn error to PM2_CONFIG_UPLOAD_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 1, stderr: "" }, // missing remote
			{ error: new Error("ssh fail") }, // upload
		]

		const { updatePM2App } = await importModuleWithMocks(responses)
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_CONFIG_UPLOAD_FAILED" })
	})

	it("maps jlist failure to PM2_STATUS_QUERY_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "old" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload
			{ code: 2, stderr: "bad pm2" }, // jlist
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "new")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_STATUS_QUERY_FAILED" })
	})

	it("maps SSH spawn error to PM2_SSH_FAILED during compare", async () => {
		const responses: TSpawnResponse[] = [{ error: new Error("no ssh") }]

		const { updatePM2App } = await importModuleWithMocks(responses)
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_SSH_FAILED" })
	})

	it("maps remote read failure to PM2_CONFIG_COMPARE_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f exists
			{ code: 2, stderr: "permission denied" }, // cat
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_CONFIG_COMPARE_FAILED" })
	})

	it("passes through callbacks in callbacks mode", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "remote" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0, stdout: "pm2 ok\n" }, // startOrReload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // jlist
		]
		const out: string[] = []
		const err: string[] = []

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
			outputMode: "callbacks",
			onStdoutLine: (line) => out.push(line),
			onStderrLine: (line) => err.push(line),
		})

		expect(result.instanceCount).toBe(1)
		expect(out.some((line) => line.includes("pm2 ok"))).toBe(true)
		expect(err).toEqual([])
	})

	it("flushes buffered stdout in callbacks mode before resolving", async () => {
		const jlist = JSON.stringify([
			{ name: "app", pm2_env: { status: "online" } },
		])
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "remote" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload
			{ code: 0, stdout: jlist }, // jlist without newline; flush on close
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
			outputMode: "callbacks",
		})

		expect(result.instanceCount).toBe(1)
	})

	it("throws PM2_APP_NAME_NOT_FOUND when app is missing before restart", async () => {
		const responses: TSpawnResponse[] = [
			// test -f missing
			{ code: 1, stderr: "" },
			// upload config
			{ code: 0 },
			// ensurePm2AppExists jlist returns different app
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "other", pm2_env: { status: "online" } },
				]),
			},
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "missing",
			}),
		).rejects.toMatchObject({ cause: "PM2_APP_NAME_NOT_FOUND" })
	})

	it("maps bad jlist JSON to PM2_STATUS_QUERY_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "remote" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload
			{ code: 0, stdout: "not-json" }, // healthcheck jlist with bad JSON
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_STATUS_QUERY_FAILED" })
	})

	it("maps PM2 command spawn error to PM2_SSH_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "remote" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload succeeds
			{ error: new Error("spawn fail") }, // jlist spawn error during healthcheck
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_SSH_FAILED" })
	})

	it("maps pm2 jlist spawn error to PM2_SSH_FAILED", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 0 }, // test -f
			{ code: 0, stdout: "remote" }, // cat
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload
			{ error: new Error("jlist spawn fail") }, // jlist during healthcheck
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_SSH_FAILED" })
	})

	it("maps local read failure to PM2_CONFIG_COMPARE_FAILED", async () => {
		const { spawnMock } = makeSpawnMock([])

		vi.doMock("node:child_process", () => ({ spawn: spawnMock }))
		vi.doMock("node:fs", () => ({
			promises: {
				readFile: vi
					.fn()
					.mockRejectedValue(new Error("local read error")),
			},
		}))

		const { updatePM2App } = await import("../src/pm2")
		await expect(
			updatePM2App({
				sshConnectionString: "host",
				remoteDir: "/remote",
				appName: "app",
			}),
		).rejects.toMatchObject({ cause: "PM2_CONFIG_COMPARE_FAILED" })
	})

	it("honors default env and restartMode", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 1, stderr: "" }, // missing remote
			{ code: 0 }, // upload
			{ code: 0 }, // startOrReload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // jlist
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // healthcheck jlist
		]
		const { updatePM2App, calls } = await importModuleWithMocks(
			responses,
			"local",
		)
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
		})

		expect(result.instanceCount).toBe(1)
		const startCall = calls.find((c) =>
			c.args.join(" ").includes("pm2 startOrReload"),
		)
		expect(startCall?.args.join(" ")).toContain("--env 'production'")
	})

	it("can run in silent mode without crashing", async () => {
		const responses: TSpawnResponse[] = [
			{ code: 1, stderr: "" }, // missing remote
			{ code: 0 }, // upload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "stopped" } },
				]),
			}, // ensurePm2AppExists jlist
			{ code: 0 }, // startOrReload
			{
				code: 0,
				stdout: JSON.stringify([
					{ name: "app", pm2_env: { status: "online" } },
				]),
			}, // jlist
		]

		const { updatePM2App } = await importModuleWithMocks(responses, "local")
		const result = await updatePM2App({
			sshConnectionString: "host",
			remoteDir: "/remote",
			appName: "app",
			outputMode: "silent",
		})
		expect(result.instanceCount).toBe(1)
	})
})
