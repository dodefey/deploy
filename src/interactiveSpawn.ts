import { spawn } from "node:child_process"

export interface TInteractiveSpawnOptions {
	command: string
	args: string[]
	cwd: string
	env: NodeJS.ProcessEnv
	onOutput: (chunk: string) => void
}

export interface TInteractiveSpawnResult {
	code: number | null
	signal?: string | null
}

export type TInteractiveSpawn = (
	options: TInteractiveSpawnOptions,
) => Promise<TInteractiveSpawnResult>

export const interactiveSpawn: TInteractiveSpawn = (options) => {
	return new Promise((resolve, reject) => {
		let sanitizedPrefix = false
		let settled = false

		const finishReject = (err: unknown) => {
			if (settled) return
			settled = true
			reject(err)
		}

		const finishResolve = (result: TInteractiveSpawnResult) => {
			if (settled) return
			settled = true
			resolve(result)
		}

		const child = spawn(
			"script",
			["-q", "/dev/null", options.command, ...options.args],
			{
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		)

		child.on("error", (err) => {
			finishReject(err)
		})

		child.stdout?.on("data", (chunk: Buffer | string) => {
			let text = chunk.toString("utf8")
			if (!sanitizedPrefix) {
				sanitizedPrefix = true
				text = text.replace(/^(?:\^D)?\x08\x08/, "")
			}
			if (text.length > 0) {
				options.onOutput(text)
			}
		})

		child.stderr?.on("data", (chunk: Buffer | string) => {
			options.onOutput(chunk.toString("utf8"))
		})

		child.on("close", (code, signal) => {
			finishResolve({
				code,
				signal: signal ?? null,
			})
		})
	})
}
