import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import type { TBuildOutputMode } from "./build.ts"

const DEFAULT_SSH_OPTS = [
	"-4",
	"-o",
	"ServerAliveInterval=30",
	"-o",
	"ServerAliveCountMax=6",
	"-o",
	"TCPKeepAlive=yes",
	"-o",
	"ConnectTimeout=20",
]

export interface TPM2Options {
	sshConnectionString: string
	remoteDir: string
	appName: string
	localEcosystemPath?: string
	env?: string
	restartMode?: "startOrReload" | "reboot"
	outputMode?: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export interface TPM2Result {
	configChanged: boolean
	instanceCount: number
}

export type TPM2ErrorCode =
	| "PM2_SSH_FAILED"
	| "PM2_CONFIG_COMPARE_FAILED"
	| "PM2_CONFIG_UPLOAD_FAILED"
	| "PM2_COMMAND_FAILED"
	| "PM2_STATUS_QUERY_FAILED"
	| "PM2_HEALTHCHECK_FAILED"
	| "PM2_APP_NAME_NOT_FOUND"

type TSshResult = {
	code: number | null
	stdout: string
	stderr: string
	spawnError?: string
}

type TRunSshOptions = {
	outputMode: TBuildOutputMode
	onStdoutLine?: (line: string) => void
	onStderrLine?: (line: string) => void
}

export async function updatePM2App(options: TPM2Options): Promise<TPM2Result> {
	const {
		sshConnectionString,
		remoteDir,
		appName,
		localEcosystemPath = path.join(process.cwd(), "ecosystem.config.js"),
		env = "production",
		restartMode = "startOrReload",
		outputMode = "inherit",
		onStdoutLine,
		onStderrLine,
	} = options

	const sshRunOptions: TRunSshOptions = {
		outputMode,
		onStdoutLine,
		onStderrLine,
	}

	const localConfigContent = await readLocalConfig(localEcosystemPath)
	const remoteConfigPath = path.join(remoteDir, "ecosystem.config.js")

	const remoteContent = await readRemoteConfig(
		sshConnectionString,
		remoteConfigPath,
		sshRunOptions,
	)

	const configChanged =
		remoteContent === null || remoteContent !== localConfigContent

	if (configChanged) {
		await uploadConfig(
			sshConnectionString,
			remoteConfigPath,
			localConfigContent,
			sshRunOptions,
		)
	}

	await ensurePm2AppExists(sshConnectionString, appName, sshRunOptions)

	await restartPm2(
		sshConnectionString,
		remoteDir,
		appName,
		env,
		restartMode,
		sshRunOptions,
	)

	const instanceCount = await verifyPM2Health(
		sshConnectionString,
		appName,
		sshRunOptions,
	)

	return { configChanged, instanceCount }
}

async function readLocalConfig(configPath: string): Promise<string> {
	try {
		return await fs.readFile(configPath, "utf8")
	} catch (err) {
		throw pm2Error(
			"PM2_CONFIG_COMPARE_FAILED",
			`Failed to read local ecosystem config at ${configPath}: ${toMessage(
				err,
			)}`,
		)
	}
}

async function readRemoteConfig(
	sshConnectionString: string,
	remotePath: string,
	sshOptions: TRunSshOptions,
): Promise<string | null> {
	const quotedPath = shellQuoteSingle(remotePath)
	const exists = await runSshCommand(
		sshConnectionString,
		`test -f ${quotedPath}`,
		sshOptions,
	)

	if (exists.spawnError) {
		throw pm2Error("PM2_SSH_FAILED", exists.spawnError)
	}

	if (exists.code !== 0 && exists.code !== 1) {
		throw pm2Error(
			"PM2_CONFIG_COMPARE_FAILED",
			exists.stderr ||
				`ssh exited with code ${String(exists.code)} checking config`,
		)
	}

	if (exists.code === 1 && !exists.stderr.trim()) {
		return null
	}

	const content = await runSshCommand(
		sshConnectionString,
		`cat ${quotedPath}`,
		sshOptions,
	)

	if (content.spawnError) {
		throw pm2Error("PM2_SSH_FAILED", content.spawnError)
	}

	if (content.code !== 0) {
		throw pm2Error(
			"PM2_CONFIG_COMPARE_FAILED",
			content.stderr ||
				`ssh exited with code ${String(content.code)} reading config`,
		)
	}

	return content.stdout
}

async function uploadConfig(
	sshConnectionString: string,
	remotePath: string,
	content: string,
	sshOptions: TRunSshOptions,
): Promise<void> {
	const quotedPath = shellQuoteSingle(remotePath)
	const quotedDir = shellQuoteSingle(path.dirname(remotePath))
	const encoded = Buffer.from(content, "utf8").toString("base64")

	const script = [
		`mkdir -p ${quotedDir}`,
		`base64 -d > ${quotedPath} <<'EOF'`,
		encoded,
		"EOF",
	].join("\n")

	const result = await runSshCommand(sshConnectionString, script, sshOptions)

	if (result.spawnError) {
		throw pm2Error("PM2_CONFIG_UPLOAD_FAILED", result.spawnError)
	}

	if (result.code !== 0) {
		throw pm2Error(
			"PM2_CONFIG_UPLOAD_FAILED",
			result.stderr ||
				`ssh exited with code ${String(result.code)} uploading config`,
		)
	}
}

async function restartPm2(
	sshConnectionString: string,
	remoteDir: string,
	appName: string,
	env: string,
	restartMode: "startOrReload" | "reboot",
	sshOptions: TRunSshOptions,
): Promise<void> {
	if (restartMode === "startOrReload") {
		const command = [
			`cd ${shellQuoteSingle(remoteDir)}`,
			`pm2 startOrReload ecosystem.config.js --env ${shellQuoteSingle(
				env,
			)}`,
		].join(" && ")

		const result = await runSshCommand(
			sshConnectionString,
			command,
			sshOptions,
		)
		if (result.spawnError) {
			throw pm2Error("PM2_SSH_FAILED", result.spawnError)
		}
		if (result.code !== 0) {
			throw pm2Error(
				"PM2_COMMAND_FAILED",
				result.stderr ||
					`pm2 startOrReload exited with code ${String(result.code)}`,
			)
		}
		return
	}

	const deleteResult = await runSshCommand(
		sshConnectionString,
		`pm2 delete ${shellQuoteSingle(appName)}`,
		sshOptions,
	)
	if (deleteResult.spawnError) {
		throw pm2Error("PM2_SSH_FAILED", deleteResult.spawnError)
	}
	// Tolerate missing app on delete; continue regardless of code.

	const startResult = await runSshCommand(
		sshConnectionString,
		[
			`cd ${shellQuoteSingle(remoteDir)}`,
			`pm2 start ecosystem.config.js --env ${shellQuoteSingle(env)}`,
		].join(" && "),
		sshOptions,
	)
	if (startResult.spawnError) {
		throw pm2Error("PM2_SSH_FAILED", startResult.spawnError)
	}
	if (startResult.code !== 0) {
		throw pm2Error(
			"PM2_COMMAND_FAILED",
			startResult.stderr ||
				`pm2 start exited with code ${String(startResult.code)}`,
		)
	}
}

async function verifyPM2Health(
	sshConnectionString: string,
	appName: string,
	sshOptions: TRunSshOptions,
): Promise<number> {
	const attempts = 3
	const delayMs = 1000
	let lastSummary: { online: number; statuses: string } | undefined

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await runSshCommand(
			sshConnectionString,
			"pm2 jlist",
			sshOptions,
		)
		if (result.spawnError) {
			throw pm2Error("PM2_SSH_FAILED", result.spawnError)
		}
		if (result.code !== 0) {
			throw pm2Error(
				"PM2_STATUS_QUERY_FAILED",
				result.stderr ||
					`pm2 jlist exited with code ${String(result.code)}`,
			)
		}

		try {
			lastSummary = parsePm2Status(result.stdout, appName)
		} catch (err) {
			throw pm2Error(
				"PM2_STATUS_QUERY_FAILED",
				`Failed to parse pm2 jlist output: ${toMessage(err)}`,
			)
		}

		if (lastSummary.online > 0) {
			return lastSummary.online
		}

		if (attempt < attempts) {
			await delay(delayMs)
		}
	}

	throw pm2Error(
		"PM2_HEALTHCHECK_FAILED",
		`PM2 reports no online instances for ${appName} after retries${
			lastSummary?.statuses ? `; statuses: ${lastSummary.statuses}` : ""
		}`,
	)
}

async function ensurePm2AppExists(
	sshConnectionString: string,
	appName: string,
	sshOptions: TRunSshOptions,
): Promise<void> {
	const result = await runSshCommand(
		sshConnectionString,
		"pm2 jlist",
		sshOptions,
	)

	if (result.spawnError || result.code !== 0) {
		return
	}

	let procs: unknown
	try {
		procs = JSON.parse(result.stdout)
	} catch {
		return
	}

	if (!Array.isArray(procs)) {
		return
	}

	const found = procs.some((proc: unknown) => {
		// Type guard: ensure proc is an object
		if (!proc || typeof proc !== "object") {
			return false
		}

		// Safe property access after type guard
		const procObj = proc as Record<string, unknown>
		const directName =
			typeof procObj.name === "string" ? procObj.name : null
		const envName =
			procObj.pm2_env && typeof procObj.pm2_env === "object"
				? (procObj.pm2_env as Record<string, unknown>).name
				: null
		const name =
			directName || (typeof envName === "string" ? envName : null)

		return name === appName
	})

	if (!found) {
		throw pm2Error(
			"PM2_APP_NAME_NOT_FOUND",
			`No existing PM2 app named ${appName} was found in pm2 jlist. Check pm2AppName in config.ts and your ecosystem.config.js.`,
		)
	}
}

function parsePm2Status(
	jlistOutput: string,
	appName: string,
): { online: number; statuses: string } {
	let procs: unknown
	try {
		procs = JSON.parse(jlistOutput)
	} catch (err) {
		throw new Error(toMessage(err))
	}

	if (!Array.isArray(procs)) {
		throw new Error("pm2 jlist output was not an array")
	}

	const matching = procs.filter((proc: unknown) => {
		if (!proc || typeof proc !== "object") {
			return false
		}
		const procObj = proc as Record<string, unknown>
		const name =
			(typeof procObj.name === "string" ? procObj.name : null) ||
			(procObj.pm2_env && typeof procObj.pm2_env === "object"
				? (procObj.pm2_env as Record<string, unknown>).name
				: null)
		return name === appName
	})

	const online = matching.filter((proc: unknown) => {
		if (!proc || typeof proc !== "object") {
			return false
		}
		const procObj = proc as Record<string, unknown>
		const env =
			procObj.pm2_env && typeof procObj.pm2_env === "object"
				? (procObj.pm2_env as Record<string, unknown>)
				: {}
		return env.status === "online"
	}).length

	const statuses = matching
		.map((proc: unknown) => {
			if (!proc || typeof proc !== "object") {
				return "status=unknown"
			}

			const procObj = proc as Record<string, unknown>
			const pm2Env = procObj.pm2_env
			const env =
				pm2Env && typeof pm2Env === "object"
					? (pm2Env as Record<string, unknown>)
					: {}

			const id = env.pm_id
			const status =
				typeof env.status === "string" ? env.status : "unknown"
			const restarts =
				typeof env.restart_time === "number"
					? env.restart_time
					: typeof env.restartCount === "number"
						? env.restartCount
						: undefined

			const parts = []
			if (typeof id === "number" || typeof id === "string") {
				parts.push(`pm_id=${String(id)}`)
			}
			parts.push(`status=${status}`)
			if (typeof restarts === "number") {
				parts.push(`restarts=${String(restarts)}`)
			}
			return parts.join(" ")
		})
		.join("; ")

	return { online, statuses }
}

function runSshCommand(
	sshConnectionString: string,
	command: string,
	sshOptions: TRunSshOptions,
): Promise<TSshResult> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let spawnError: string | undefined
		let resolved = false

		const finish = (result: TSshResult) => {
			if (resolved) return
			resolved = true
			resolve(result)
		}

		const stdio = resolveStdio(sshOptions.outputMode)
		const child = spawn(
			"ssh",
			[...DEFAULT_SSH_OPTS, sshConnectionString, command],
			{
				stdio,
			},
		)

		if (sshOptions.outputMode === "callbacks") {
			const { flushRemaining } = wireCallbacks(
				child,
				sshOptions,
				(out) => {
					stdout += out
				},
				(err) => {
					stderr += err
				},
			)

			child.on("close", (code) => {
				flushRemaining()
				finish({ code, stdout, stderr, spawnError })
			})
		} else {
			child.stdout?.on("data", (chunk) => {
				const text = String(chunk)
				stdout += text
				if (sshOptions.outputMode === "inherit") {
					process.stdout.write(text)
				}
			})
			child.stderr?.on("data", (chunk) => {
				const text = String(chunk)
				stderr += text
				if (sshOptions.outputMode === "inherit") {
					process.stderr.write(text)
				}
			})

			child.on("close", (code) => {
				finish({ code, stdout, stderr, spawnError })
			})
		}

		child.on("error", (err) => {
			spawnError = toMessage(err)
			stderr += toMessage(err)
			finish({ code: 1, stdout, stderr, spawnError })
		})
	})
}

function resolveStdio(
	outputMode: TBuildOutputMode,
): ["ignore", "ignore", "ignore"] | ["ignore", "pipe", "pipe"] {
	if (outputMode === "silent") return ["ignore", "ignore", "ignore"]
	// Use pipes even in inherit so we can still capture output for logic.
	return ["ignore", "pipe", "pipe"]
}

function wireCallbacks(
	child: ReturnType<typeof spawn>,
	sshOptions: TRunSshOptions,
	onStdout: (chunk: string) => void,
	onStderr: (chunk: string) => void,
): { flushRemaining: () => void } {
	let stdoutBuffer = ""
	let stderrBuffer = ""

	child.stdout?.on("data", (chunk) => {
		const text = String(chunk)
		if (!sshOptions.onStdoutLine) {
			onStdout(text)
			return
		}
		stdoutBuffer += text
		stdoutBuffer = flushLines(
			stdoutBuffer,
			sshOptions.onStdoutLine,
			onStdout,
		)
	})

	child.stderr?.on("data", (chunk) => {
		const text = String(chunk)
		if (!sshOptions.onStderrLine) {
			onStderr(text)
			return
		}
		stderrBuffer += text
		stderrBuffer = flushLines(
			stderrBuffer,
			sshOptions.onStderrLine,
			onStderr,
		)
	})

	const flushRemaining = (): void => {
		if (stdoutBuffer) {
			flushLines(stdoutBuffer + "\n", sshOptions.onStdoutLine, onStdout)
			stdoutBuffer = ""
		}
		if (stderrBuffer) {
			flushLines(stderrBuffer + "\n", sshOptions.onStderrLine, onStderr)
			stderrBuffer = ""
		}
	}

	return { flushRemaining }
}

function flushLines(
	buffer: string,
	cb: ((line: string) => void) | undefined,
	collect: (chunk: string) => void,
): string {
	if (!cb) return ""
	const lines = buffer.split(/\r?\n/)
	const incomplete = lines.pop() ?? ""
	for (const line of lines) {
		cb(line)
		collect(line + "\n")
	}
	return incomplete
}

function shellQuoteSingle(value: string): string {
	return "'" + value.replace(/'/g, `'"'"'`) + "'"
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function pm2Error(code: TPM2ErrorCode, message: string): Error {
	const error = new Error(message)
	error.cause = code
	return error
}
