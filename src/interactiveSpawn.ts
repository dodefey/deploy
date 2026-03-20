import { spawn as spawnPty } from "node-pty"

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
		let ptyProcess: ReturnType<typeof spawnPty>

		try {
			ptyProcess = spawnPty(options.command, options.args, {
				cwd: options.cwd,
				env: options.env,
				name: process.env.TERM || "xterm-256color",
				cols: process.stdout.columns ?? 80,
				rows: process.stdout.rows ?? 24,
			})
		} catch (err) {
			reject(err)
			return
		}

		const handleResize = () => {
			try {
				ptyProcess.resize(
					process.stdout.columns ?? 80,
					process.stdout.rows ?? 24,
				)
			} catch {
				// Resize failures are non-fatal to command execution.
			}
		}

		process.stdout.on("resize", handleResize)
		ptyProcess.onData((chunk) => {
			options.onOutput(chunk)
		})
		ptyProcess.onExit(({ exitCode, signal }) => {
			process.stdout.off("resize", handleResize)
			resolve({
				code: exitCode,
				signal:
					typeof signal === "number"
						? String(signal)
						: signal ?? null,
			})
		})
	})
}
