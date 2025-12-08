import type { TChurnMetrics } from "./churn.ts"
import { formatChurnMetrics } from "./churnFormat.js"
import type { TChurnDisplayOptions } from "./churnFormat.ts"

export interface TLoggerSink {
	info(line: string): void
	error(line: string): void
}

const consoleSink: TLoggerSink = {
	info: (line) => {
		console.log(line)
	},
	error: (line) => {
		console.error(line)
	},
}

let currentSink: TLoggerSink = consoleSink

export function setLoggerSink(sink: TLoggerSink | null | undefined): void {
	currentSink = sink ?? consoleSink
}

export interface TLogContext {
	profileName?: string
}

export interface TPm2Context extends TLogContext {
	appName: string
	restartMode: "startOrReload" | "reboot"
	instanceCount: number
}

export function extractErrorCode(err: unknown): string | undefined {
	if (err instanceof Error && typeof err.cause === "string") {
		return err.cause
	}
	return undefined
}

export function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function formatFatalError(
	label: string,
	code: string | undefined,
	message: string,
	profileName?: string,
): string {
	if (code && profileName) {
		return `${label} error [${code}] (profile="${profileName}"): ${message}`
	}
	if (code) {
		return `${label} error [${code}]: ${message}`
	}
	if (profileName) {
		return `${label} error (profile="${profileName}"): ${message}`
	}
	return `${label} error: ${message}`
}

export function formatNonFatalError(
	label: string,
	code: string | undefined,
	message: string,
	profileName?: string,
): string {
	if (code && profileName) {
		return `Deploy succeeded, but ${label} step failed [${code}] (profile="${profileName}"): ${message}`
	}
	if (code) {
		return `Deploy succeeded, but ${label} step failed [${code}]: ${message}`
	}
	if (profileName) {
		return `Deploy succeeded, but ${label} step failed (profile="${profileName}"): ${message}`
	}
	return `Deploy succeeded, but ${label} step failed: ${message}`
}

export function logDeployStart(ctx: TLogContext): void {
	if (ctx.profileName) {
		currentSink.info(
			`[deploy] Starting deploy for profile "${ctx.profileName}"...`,
		)
		return
	}
	currentSink.info("[deploy] Starting deploy...")
}

export function logDeploySuccess(ctx: TLogContext): void {
	if (ctx.profileName) {
		currentSink.info(
			`[deploy] Deploy completed successfully for profile "${ctx.profileName}".`,
		)
		return
	}
	currentSink.info("[deploy] Deploy completed successfully.")
}

export function logChurnOnlyStart(ctx: TLogContext): void {
	if (ctx.profileName) {
		currentSink.info(
			`[deploy] Starting churn-only run for profile "${ctx.profileName}"...`,
		)
		return
	}
	currentSink.info("[deploy] Starting churn-only run...")
}

export function logChurnOnlySuccess(ctx: TLogContext): void {
	if (ctx.profileName) {
		currentSink.info(
			`[deploy] Churn-only run completed successfully for profile "${ctx.profileName}".`,
		)
		return
	}
	currentSink.info("[deploy] Churn-only run completed successfully.")
}

export function logPhaseStart(name: string): void {
	currentSink.info(`[deploy] ${name}...`)
}

export function logPhaseSuccess(message: string): void {
	currentSink.info(`[deploy] ${message}`)
}

export function logPm2Success(ctx: TPm2Context): void {
	currentSink.info(
		`[deploy] PM2 update complete for "${ctx.appName}": ${String(ctx.instanceCount)} instances online (mode: ${ctx.restartMode}).`,
	)
}

export function logChurnSummary(
	metrics: TChurnMetrics,
	options?: TChurnDisplayOptions,
): void {
	currentSink.info(formatChurnMetrics(metrics, options))
}

export function logFatalError(
	label: string,
	err: unknown,
	ctx?: TLogContext,
): void {
	const code = extractErrorCode(err)
	const message = toErrorMessage(err)
	currentSink.error(formatFatalError(label, code, message, ctx?.profileName))
}

export function logNonFatalError(
	label: string,
	err: unknown,
	ctx?: TLogContext,
): void {
	const code = extractErrorCode(err)
	const message = toErrorMessage(err)
	currentSink.error(
		formatNonFatalError(label, code, message, ctx?.profileName),
	)
}

export function logUnexpectedError(err: unknown, ctx?: TLogContext): void {
	const code = extractErrorCode(err)
	const message = toErrorMessage(err)
	const profile = ctx?.profileName

	if (profile && code) {
		currentSink.error(
			`[deploy] Unexpected deploy error [${code}] (profile="${profile}"): ${message}`,
		)
		return
	}
	if (profile) {
		currentSink.error(
			`[deploy] Unexpected deploy error (profile="${profile}"): ${message}`,
		)
		return
	}
	if (code) {
		currentSink.error(
			`[deploy] Unexpected deploy error [${code}]: ${message}`,
		)
		return
	}
	currentSink.error(`[deploy] Unexpected deploy error: ${message}`)
}
