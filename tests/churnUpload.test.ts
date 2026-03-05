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
	stdin: string
}

function makeSpawnMock(responses: TSpawnResponse[]) {
	const calls: TSpawnCall[] = []
	const spawnMock = vi.fn((command: string, args: string[]) => {
		const child: Partial<ChildProcess> =
			new PassThrough() as unknown as ChildProcess
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		child.stdin = new PassThrough()

		const call: TSpawnCall = { command, args: [...args], stdin: "" }
		child.stdin.on("data", (chunk) => {
			call.stdin += String(chunk)
		})
		calls.push(call)

		const response = responses.shift() ?? {}
		queueMicrotask(() => {
			if (response.error) {
				child.emit?.("error", response.error)
				return
			}
			if (response.stdout) {
				child.stdout?.emit("data", response.stdout)
			}
			if (response.stderr) {
				child.stderr?.emit("data", response.stderr)
			}
			child.emit?.("exit", response.code ?? 0)
		})

		return child as ChildProcess
	})

	return { spawnMock, calls }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.resetModules()
})

async function importModuleWithMocks(responses: TSpawnResponse[]) {
	const { spawnMock, calls } = makeSpawnMock(responses)
	vi.doMock("node:child_process", () => ({ spawn: spawnMock }))
	const { uploadRemoteManifest } = await import("../src/churn")
	return { uploadRemoteManifest, calls }
}

describe("uploadRemoteManifest", () => {
	it("streams manifest content via stdin instead of embedding payload in command args", async () => {
		const { uploadRemoteManifest, calls } = await importModuleWithMocks([
			{ code: 0 },
		])
		const payload =
			JSON.stringify({ files: "x".repeat(500_000), schema: "manifest" }) +
			"\n"

		await uploadRemoteManifest(
			"user@host",
			"/var/www/app/.deploy/manifest.json",
			payload,
			["-o", "BatchMode=yes"],
		)

		expect(calls).toHaveLength(1)
		const call = calls[0]
		expect(call).toBeTruthy()
		expect(call?.command).toBe("ssh")
		expect(call?.args).toEqual([
			"-o",
			"BatchMode=yes",
			"user@host",
			"mkdir -p '/var/www/app/.deploy' && cat > '/var/www/app/.deploy/manifest.json'",
		])
		expect(call?.stdin).toBe(payload)
		expect(call?.args[3]).not.toContain(payload.slice(0, 128))
	})

	it("maps non-zero ssh exit codes to CHURN_REMOTE_MANIFEST_UPLOAD_FAILED", async () => {
		const { uploadRemoteManifest } = await importModuleWithMocks([
			{ code: 2, stderr: "permission denied" },
		])

		await expect(
			uploadRemoteManifest(
				"user@host",
				"/var/www/app/.deploy/manifest.json",
				"{\"schema\":\"x\"}\n",
				["-o", "BatchMode=yes"],
			),
		).rejects.toMatchObject({
			cause: "CHURN_REMOTE_MANIFEST_UPLOAD_FAILED",
			message: "permission denied",
		})
	})
})
