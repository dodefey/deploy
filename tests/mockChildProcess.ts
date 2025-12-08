import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable, type Writable } from "node:stream"

export interface IAdvancedMockChildProcess extends ChildProcess {
	stdout: Readable | null
	stderr: Readable | null

	pushStdout(data: string | Buffer): void
	pushStderr(data: string | Buffer): void
	scheduleStdout(data: string | Buffer, delayMs: number): Promise<void>
	scheduleStderr(data: string | Buffer, delayMs: number): Promise<void>

	triggerError(err: NodeJS.ErrnoException | Error): void
	triggerClose(code: number | null, signal: NodeJS.Signals | null): void

	events: Array<{ type: string; payload?: unknown }>
	reset(): void
}

class AdvancedMockChildProcess
	extends EventEmitter
	implements IAdvancedMockChildProcess
{
	stdout: PassThrough | null
	stderr: PassThrough | null
	stdin: Writable | null = null
	stdio: [
		Writable | null,
		Readable | null,
		Readable | null,
		Readable | Writable | null,
		Readable | Writable | null,
	]

	pid = 99999
	connected = true
	killed = false
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	spawnargs: string[] = []
	spawnfile = ""

	events: Array<{ type: string; payload?: unknown }> = []

	constructor() {
		super()
		this.stdout = new PassThrough()
		this.stderr = new PassThrough()
		this.stdio = [this.stdin, this.stdout, this.stderr, null, null]
	}

	pushStdout(data: string | Buffer): void {
		this.record("stdout", data)
		this.stdout?.emit("data", data)
	}

	pushStderr(data: string | Buffer): void {
		this.record("stderr", data)
		this.stderr?.emit("data", data)
	}

	async scheduleStdout(
		data: string | Buffer,
		delayMs: number,
	): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		this.pushStdout(data)
	}

	async scheduleStderr(
		data: string | Buffer,
		delayMs: number,
	): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		this.pushStderr(data)
	}

	triggerError(err: NodeJS.ErrnoException | Error): void {
		this.record("error", err)
		this.emit("error", err)
	}

	triggerClose(code: number | null, signal: NodeJS.Signals | null): void {
		this.record("close", { code, signal })
		this.exitCode = code
		this.signalCode = signal
		this.emit("close", code, signal)
		this.emit("exit", code, signal)
	}

	send(): boolean {
		return false
	}

	kill(): boolean {
		this.killed = true
		return true
	}

	disconnect(): void {
		this.connected = false
	}

	unref(): this {
		return this
	}

	ref(): this {
		return this
	}

	[Symbol.dispose](): void {
		// no-op for mock
	}

	reset(): void {
		this.events.length = 0
		this.exitCode = null
		this.signalCode = null
		this.killed = false
		this.connected = true

		this.removeAllListeners()
		this.stdout?.removeAllListeners()
		this.stderr?.removeAllListeners()
	}

	private record(type: string, payload?: unknown) {
		this.events.push({ type, payload })
	}
}

export function createAdvancedMockChildProcess(): IAdvancedMockChildProcess {
	return new AdvancedMockChildProcess()
}
