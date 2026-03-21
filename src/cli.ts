#!/usr/bin/env node

import { cli, define } from "gunshi"
import { createWriteStream, promises as fs, type WriteStream } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { TBuildOutputMode } from "./build.js"
import { runBuild } from "./build.js"
import type { TChurnMetrics } from "./churn.js"
import { computeClientChurnReport } from "./churn.js"
import { formatChurnReportDiagnostics } from "./churnDiagnosticsFormat.js"
import type { TChurnReportV1 } from "./churnSchema.js"
import type {
	TConfigErrorCode,
	TResolvedConfig,
	TResolvedLoggingConfig,
} from "./config.js"
import { listProfiles, resolveProfile } from "./config.js"
import {
	createCompositeLoggerSink,
	createWriterLoggerSink,
	logChurnOnlyStart,
	logChurnOnlySuccess,
	logChurnSummary,
	logDeployStart,
	logDeploySuccess,
	logFatalError,
	logNonFatalError,
	logPhaseStart,
	logPhaseSuccess,
	logPm2Success,
	logUnexpectedError,
	setLoggerSink,
	toErrorMessage,
} from "./deployLogging.js"
import { updatePM2App } from "./pm2.js"
import { syncBuild } from "./syncBuild.js"
import { runTests } from "./test.js"

// Exit semantics:
// - Fatal phases: configuration, tests, build, sync, churn-only (exit code 1 via handleFatalError).
// - Non-fatal phases: PM2 and churn (full deploy) log errors; exit code stays 0 if fatal phases succeed.
// - main() sets process.exitCode after command completion so pending output can flush.

const noop = (): void => {}
let lastProfileUsed: string | undefined
const DEFAULT_CHURN_HISTORY_OUT = ".deploy/churn-history.jsonl"
const FATAL_DEPLOY_ERROR = Symbol("FATAL_DEPLOY_ERROR")

interface TRunLogWriter {
	writeLine(line: string): void
	writeChunk(chunk: string): void
	writeEvent(event: TDeployLogEvent): void
	close(): Promise<void>
	path: string
}

interface TPhaseOutputHandlers {
	outputMode: TBuildOutputMode
	onStdoutChunk?: (chunk: string) => void
	onStderrChunk?: (chunk: string) => void
}

type TTestPhaseOutputHandlers = TPhaseOutputHandlers
type TDeployPhase = "deploy" | "tests" | "build" | "sync" | "pm2" | "churn"
type TDeployLogKind =
	| "start"
	| "command"
	| "summary"
	| "result"
	| "error"
	| "output"

interface TDeployLogEvent {
	timestamp: string
	phase: TDeployPhase
	kind: TDeployLogKind
	message?: string
	data?: Record<string, unknown>
}

interface TVitestAssertionResult {
	fullName: string
	status: string
	title: string
	failureMessages?: string[]
}

interface TVitestSuiteResult {
	name: string
	status: string
	message?: string
	assertionResults?: TVitestAssertionResult[]
}

interface TVitestJsonReport {
	success: boolean
	numTotalTestSuites: number
	numPassedTestSuites: number
	numFailedTestSuites: number
	numPendingTestSuites: number
	numTotalTests: number
	numPassedTests: number
	numFailedTests: number
	numPendingTests: number
	numTodoTests: number
	testResults?: TVitestSuiteResult[]
}

interface TDeployArgs {
	sshConnectionString: string
	remoteDir: string
	buildDir: string
	buildCommand: string
	buildArgs: string[]
	env: string
	pm2AppName: string
	pm2RestartMode: "startOrReload" | "reboot"
	dryRun: boolean
	skipTests: boolean
	skipBuild: boolean
	verbose: boolean
	churnOnly: boolean
	profileName: string
	logging?: TResolvedLoggingConfig
	churnDiagnostics?: TChurnDiagnosticsMode
	churnTopN?: number
	churnReportOut?: string
	churnHistoryOut?: string
	churnGroupRules?: Array<{ pattern: string; group: string }>
}

type TChurnDiagnosticsMode = "off" | "compact" | "full" | "json"
type TResolvedConfigWithOptionalChurn = Omit<TResolvedConfig, "churn" | "logging"> & {
	churn?: TResolvedConfig["churn"]
	logging?: TResolvedConfig["logging"]
}

const deployCommand = define({
	name: "deploy",
	description:
		"Deploy the build, sync output to the server, update PM2, and compute churn",
	args: {
		profile: {
			type: "string",
			short: "p",
			description:
				"Deploy profile name (from profiles.json). Required; no default profile is applied",
			default: undefined,
		},
		sshConnectionString: {
			type: "string",
			short: "s",
			description:
				"Override SSH connection string for this run (e.g. user@example.com)",
			default: undefined,
		},
		remoteDir: {
			type: "string",
			short: "d",
			description:
				"Override remote app directory on the server (base path for build and PM2)",
			default: undefined,
		},
		buildDir: {
			type: "string",
			short: "b",
			description:
				"Override local build output directory (where build artifacts live)",
			default: undefined,
		},
		env: {
			type: "string",
			short: "e",
			description:
				"Override PM2 environment name for this run (e.g. production, development)",
			default: undefined,
		},
		pm2AppName: {
			type: "string",
			description:
				"Override PM2 app name (ecosystem process name to reload)",
			default: undefined,
		},
		pm2RestartMode: {
			type: "string",
			description:
				"Override PM2 restart mode for this run (startOrReload or reboot)",
			default: undefined,
		},
		skipTests: {
			type: "boolean",
			short: "T",
			description: "Skip running tests before deploy (use with caution)",
			default: false,
		},
		dryRun: {
			type: "boolean",
			short: "n",
			description:
				"Perform a dry run (build and compute churn, rsync in --dry-run mode, no remote writes or PM2 updates)",
			default: false,
		},
		skipBuild: {
			type: "boolean",
			short: "k",
			description: "Skip build; reuse the existing build in buildDir",
			default: false,
		},
		verbose: {
			type: "boolean",
			short: "V",
			description:
				"Verbose output; show full build, rsync, and PM2 logs (matches -V)",
			default: false,
		},
		churnOnly: {
			type: "boolean",
			short: "c",
			description:
				"Run client churn analysis only (no build, no sync, no PM2; uses current buildDir)",
			default: false,
		},
		churnDiagnostics: {
			type: "string",
			description:
				"Churn diagnostics output mode (off, compact, full, json). Defaults to profile churn.diagnosticsDefault or off.",
			default: undefined,
		},
		churnTopN: {
			type: "string",
			description:
				"Top offenders count for churn diagnostics (positive integer). Defaults to profile churn.topN or 5.",
			default: undefined,
		},
		churnReportOut: {
			type: "string",
			description:
				'Optional churn report output destination: "stdout" or a file path.',
			default: undefined,
		},
		churnHistoryOut: {
			type: "string",
			description:
				'Churn history destination: "stdout", "off", or a JSONL file path (append mode). Defaults to .deploy/churn-history.jsonl; use "off" to disable.',
			default: undefined,
		},
	},
	run: async (ctx) => {
		const values = ctx.values as {
			sshConnectionString?: string
			remoteDir?: string
			buildDir?: string
			env?: string
			pm2AppName?: string
			pm2RestartMode?: string
			skipTests: boolean
			dryRun: boolean
			skipBuild: boolean
			verbose: boolean
			churnOnly: boolean
			churnDiagnostics?: string
			churnTopN?: string
			churnReportOut?: string
			churnHistoryOut?: string
			profile?: string
		}

		let deploy: TDeployArgs
		let logWriter: TRunLogWriter | undefined
		try {
			const resolved = selectConfig(values.profile, values.verbose)
			const merged = applyOverrides(resolved, values)
			deploy = buildDeployArgs(merged, {
				dryRun: values.dryRun,
				skipTests: values.skipTests,
				skipBuild: values.skipBuild,
				verbose: values.verbose,
				churnOnly: values.churnOnly,
				churnDiagnostics: values.churnDiagnostics,
				churnTopN: values.churnTopN,
				churnReportOut: values.churnReportOut,
				churnHistoryOut: values.churnHistoryOut,
			})
			lastProfileUsed = deploy.profileName
			if (resolveLoggingConfig(deploy.logging).file.enabled) {
				logWriter = await createRunLogWriter(deploy)
			}
		} catch (err) {
			handleFatalError("Configuration", err, values.profile)
		}

		try {
			installRunLoggerSink(logWriter)

			if (deploy.churnOnly) {
				await runChurnOnlyMode(deploy, logWriter)
				return
			}

			logDeployStart({ profileName: deploy.profileName })

			await runTestPhase(deploy, logWriter)

			await runBuildPhase(deploy, logWriter)
			await runSyncPhase(deploy, logWriter)
			await runPm2Phase(deploy, logWriter)
			await runChurnPhase(deploy, logWriter)
			logDeploySuccess({ profileName: deploy.profileName })
			return
		} finally {
			setLoggerSink(null)
			await logWriter?.close()
		}
	},
})

async function runBuildPhase(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): Promise<void> {
	logPhaseStart("Running build")
	if (values.skipBuild) {
		logPhaseSuccess("Build skipped (per --skipBuild / -k).")
		return
	}
	writeDeployLogEvent(logWriter, {
		phase: "build",
		kind: "start",
		message: "Running build",
	})
	writeDeployLogEvent(logWriter, {
		phase: "build",
		kind: "command",
		message: "Executing build command",
		data: {
			command: values.buildCommand,
			args: values.buildArgs,
			cwd: process.cwd(),
		},
	})
	const handlers = createPhaseOutputHandlers(values, logWriter)
	try {
		await runBuild(
			{
				command: values.buildCommand,
				args: values.buildArgs,
			},
			{
				rootDir: process.cwd(),
				outputMode: handlers.outputMode,
				onStdoutChunk: handlers.onStdoutChunk,
				onStderrChunk: handlers.onStderrChunk,
			},
		)
		writeDeployLogEvent(logWriter, {
			phase: "build",
			kind: "result",
			message: "Build completed successfully",
		})
		logPhaseSuccess("Build completed successfully.")
	} catch (err) {
		writePhaseErrorEvent(logWriter, "build", err)
		handleFatalError("Build", err, values.profileName)
	}
}

async function runTestPhase(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): Promise<void> {
	logPhaseStart("Running test suite")
	if (values.skipTests) {
		logPhaseSuccess("Test suite skipped (per --skipTests / -T).")
		return
	}
	writeDeployLogEvent(logWriter, {
		phase: "tests",
		kind: "start",
		message: "Running test suite",
	})
	const handlers = createTestPhaseOutputHandlers(values, logWriter)
	const reportArtifact = logWriter
		? await createVitestReportArtifact()
		: undefined
	const testArgs = createDeployVitestArgs(reportArtifact?.reportPath)
	writeDeployLogEvent(logWriter, {
		phase: "tests",
		kind: "command",
		message: "Executing test command",
		data: {
			command: "npx",
			args: testArgs,
			cwd: process.cwd(),
			reportPath: reportArtifact?.reportPath,
		},
	})
	let phaseError: unknown
	try {
		await runTests({
			testBin: "npx",
			testArgs,
			outputMode: handlers.outputMode,
			onStdoutChunk: handlers.onStdoutChunk,
			onStderrChunk: handlers.onStderrChunk,
		})
	} catch (err) {
		phaseError = err
	} finally {
		if (reportArtifact) {
			await writeVitestReportToDeployLog(logWriter, reportArtifact.reportPath)
			await fs.rm(reportArtifact.dir, { recursive: true, force: true })
		}
	}
	if (phaseError) {
		writePhaseErrorEvent(logWriter, "tests", phaseError)
		handleFatalError("Tests", phaseError, values.profileName)
	}
	writeDeployLogEvent(logWriter, {
		phase: "tests",
		kind: "result",
		message: "Test suite completed successfully",
	})
	logPhaseSuccess("Test suite completed successfully.")
}

async function runSyncPhase(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): Promise<void> {
	logPhaseStart("Syncing client bundle to server")
	writeDeployLogEvent(logWriter, {
		phase: "sync",
		kind: "start",
		message: "Syncing client bundle to server",
	})
	const handlers = createPhaseOutputHandlers(values, logWriter)
	const options = {
		sshConnectionString: values.sshConnectionString,
		remoteDir: values.remoteDir,
		localOutputDir: values.buildDir,
		dryRun: values.dryRun,
		outputMode: handlers.outputMode as TBuildOutputMode,
		onStdoutChunk: handlers.onStdoutChunk,
		onStderrChunk: handlers.onStderrChunk,
	}
	writeDeployLogEvent(logWriter, {
		phase: "sync",
		kind: "command",
		message: "Executing sync commands",
		data: {
			sshConnectionString: values.sshConnectionString,
			remoteDir: values.remoteDir,
			localOutputDir: values.buildDir,
			dryRun: values.dryRun,
		},
	})

	try {
		await syncBuild(options)
		writeDeployLogEvent(logWriter, {
			phase: "sync",
			kind: "result",
			message: "Client bundle sync complete",
			data: {
				dryRun: values.dryRun,
				remoteDir: values.remoteDir,
			},
		})
		logPhaseSuccess("Client bundle sync complete.")
	} catch (err) {
		writePhaseErrorEvent(logWriter, "sync", err)
		handleFatalError("Build sync", err, values.profileName)
	}
}

async function runPm2Phase(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): Promise<void> {
	logPhaseStart(`Updating PM2 app "${values.pm2AppName}"`)
	if (values.dryRun) {
		logPhaseSuccess("PM2 update complete: skipped.")
		return
	}

	writeDeployLogEvent(logWriter, {
		phase: "pm2",
		kind: "start",
		message: "Updating PM2 app",
		data: {
			appName: values.pm2AppName,
			restartMode: values.pm2RestartMode,
		},
	})
	const handlers = createPhaseOutputHandlers(values, logWriter)
	writeDeployLogEvent(logWriter, {
		phase: "pm2",
		kind: "command",
		message: "Executing PM2 update workflow",
		data: {
			sshConnectionString: values.sshConnectionString,
			remoteDir: values.remoteDir,
			appName: values.pm2AppName,
			env: values.env,
			restartMode: values.pm2RestartMode,
		},
	})
	try {
		const result = await updatePM2App({
			sshConnectionString: values.sshConnectionString,
			remoteDir: values.remoteDir,
			appName: values.pm2AppName,
			env: values.env,
			restartMode: values.pm2RestartMode,
			outputMode: handlers.outputMode,
			onStdoutChunk: handlers.onStdoutChunk,
			onStderrChunk: handlers.onStderrChunk,
		})
		writeDeployLogEvent(logWriter, {
			phase: "pm2",
			kind: "result",
			message: "PM2 update complete",
			data: {
				configChanged: result.configChanged,
				instanceCount: result.instanceCount,
				appName: values.pm2AppName,
				restartMode: values.pm2RestartMode,
			},
		})
		logPm2Success({
			appName: values.pm2AppName,
			restartMode: values.pm2RestartMode,
			instanceCount: result.instanceCount,
			profileName: values.profileName,
		})
	} catch (err) {
		writePhaseErrorEvent(logWriter, "pm2", err)
		if (err instanceof Error && err.cause === "PM2_APP_NAME_NOT_FOUND") {
			handleFatalError("PM2 update", err, values.profileName)
		} else {
			logNonFatalError("PM2 update", err, {
				profileName: values.profileName,
			})
		}
	}
}

async function runChurnPhase(
	values: TDeployArgs,
	_logWriter?: TRunLogWriter,
): Promise<void> {
	logPhaseStart("Computing client churn metrics")
	try {
		await runChurnAnalysis(values, "deploy")
		logPhaseSuccess("Client churn analysis complete.")
	} catch (err) {
		logNonFatalError("Client churn", err, {
			profileName: values.profileName,
		})
	}
}

async function runChurnOnlyMode(
	values: TDeployArgs,
	_logWriter?: TRunLogWriter,
): Promise<void> {
	logChurnOnlyStart({ profileName: values.profileName })
	logPhaseStart("Computing client churn metrics")
	try {
		await runChurnAnalysis(values, "churnOnly")
		logPhaseSuccess("Client churn analysis complete.")
		logChurnOnlySuccess({ profileName: values.profileName })
	} catch (err) {
		handleFatalError("Client churn", err, values.profileName)
	}
}

async function runChurnAnalysis(
	values: TDeployArgs,
	runMode: "deploy" | "churnOnly",
): Promise<void> {
	const mode = values.churnDiagnostics ?? "off"
	const report = await computeClientChurnReport({
		buildDir: values.buildDir,
		sshConnectionString: values.sshConnectionString,
		remoteDir: values.remoteDir,
		dryRun: values.dryRun,
		profileName: values.profileName,
		runMode,
		groupRules: values.churnGroupRules ?? [],
	})

	logChurnSummary(reportCoreToMetrics(report), { dryRun: values.dryRun })

	if (mode !== "off") {
		logPhaseSuccess(
			formatChurnReportDiagnostics(report, {
				mode,
				topN: values.churnTopN,
			}),
		)
	}

	if (values.churnReportOut) {
		await writeChurnReport(report, values.churnReportOut)
	}

	if (values.churnHistoryOut) {
		await appendChurnHistory(report, values.churnHistoryOut)
	}
}

function selectConfig(
	requestedProfile: string | undefined,
	verbose: boolean,
): TResolvedConfig {
	const profiles = listProfiles()
	if (profiles.length === 0) {
		const err = new Error("No deploy profiles are configured; aborting.")
		err.cause = "CONFIG_PROFILE_FILE_NOT_FOUND"
		throw err
	}

	const profileName = requestedProfile
	if (!profileName) {
		const err = new Error(
			"Please choose a deploy profile with --profile/-p; no default profile is applied.",
		)
		err.cause = "CONFIG_PROFILE_NOT_FOUND"
		throw err
	}

	try {
		const resolved = resolveProfile(profileName)
		if (verbose) {
			logPhaseSuccess(`Using profile "${profileName}" from profiles.json`)
		}
		return resolved
	} catch (err) {
		const code =
			err instanceof Error && typeof err.cause === "string"
				? (err.cause as TConfigErrorCode)
				: undefined
		const message = toErrorMessage(err)
		const wrapped = new Error(
			code
				? `Config error [${code}] for profile "${profileName}": ${message}`
				: `Config error for profile "${profileName}": ${message}`,
		)
		wrapped.cause = code ?? err
		throw wrapped
	}
}

const isRestartMode = (mode: string): mode is "startOrReload" | "reboot" => {
	return mode === "startOrReload" || mode === "reboot"
}
function applyOverrides(
	config: TResolvedConfig,
	overrides: {
		sshConnectionString?: string
		remoteDir?: string
		buildDir?: string
		env?: string
		pm2AppName?: string
		pm2RestartMode?: string
	},
): TResolvedConfig {
	const restartMode = overrides.pm2RestartMode?.trim()
	if (restartMode && !isRestartMode(restartMode)) {
		const err = new Error(
			`Invalid pm2RestartMode override "${restartMode}". Use "startOrReload" or "reboot".`,
		)
		err.cause = "CONFIG_INVALID_RESTART_MODE"
		throw err
	}

	const validatedRestartMode =
		restartMode && isRestartMode(restartMode) ? restartMode : undefined

	return {
		name: config.name,
		sshConnectionString:
			overrides.sshConnectionString?.trim() || config.sshConnectionString,
		remoteDir: overrides.remoteDir?.trim() || config.remoteDir,
		buildDir: overrides.buildDir?.trim() || config.buildDir,
		env: overrides.env?.trim() || config.env,
		pm2AppName: overrides.pm2AppName?.trim() || config.pm2AppName,
		pm2RestartMode: validatedRestartMode || config.pm2RestartMode,
		buildCommand: config.buildCommand,
		buildArgs: config.buildArgs,
		churn: config.churn,
		logging: config.logging,
	}
}

function buildDeployArgs(
	merged: TResolvedConfigWithOptionalChurn,
	values: {
		dryRun: boolean
		skipTests: boolean
		skipBuild: boolean
		verbose: boolean
		churnOnly: boolean
		churnDiagnostics?: string
		churnTopN?: string
		churnReportOut?: string
		churnHistoryOut?: string
	},
): TDeployArgs {
	const churnDefaults = merged.churn ?? {
		diagnosticsDefault: "off" as const,
		topN: 5,
		groupRules: [],
	}
	const loggingDefaults = resolveLoggingConfig(merged.logging)

	return {
		sshConnectionString: merged.sshConnectionString,
		remoteDir: merged.remoteDir,
		buildDir: merged.buildDir,
		buildCommand: merged.buildCommand,
		buildArgs: merged.buildArgs,
		env: merged.env,
		pm2AppName: merged.pm2AppName,
		pm2RestartMode: merged.pm2RestartMode,
		dryRun: values.dryRun,
		skipTests: values.skipTests,
		skipBuild: values.skipBuild,
		verbose: values.verbose || loggingDefaults.console.verboseDefault,
		churnOnly: values.churnOnly,
		profileName: merged.name,
		logging: loggingDefaults,
		churnDiagnostics: resolveChurnDiagnosticsMode(
			values.churnDiagnostics,
			churnDefaults.diagnosticsDefault,
		),
		churnTopN: resolveChurnTopN(values.churnTopN, churnDefaults.topN),
		churnReportOut: normalizeChurnReportOut(values.churnReportOut),
		churnHistoryOut: resolveChurnHistoryOut(
			values.churnHistoryOut,
			DEFAULT_CHURN_HISTORY_OUT,
		),
		churnGroupRules: churnDefaults.groupRules,
	}
}

function resolveChurnDiagnosticsMode(
	overrideValue: string | undefined,
	defaultValue: TChurnDiagnosticsMode,
): TChurnDiagnosticsMode {
	if (!overrideValue) return defaultValue
	const trimmed = overrideValue.trim()
	if (
		trimmed === "off" ||
		trimmed === "compact" ||
		trimmed === "full" ||
		trimmed === "json"
	) {
		return trimmed
	}
	const err = new Error(
		`Invalid churnDiagnostics value "${overrideValue}". Use off, compact, full, or json.`,
	)
	err.cause = "CONFIG_PROFILE_INVALID"
	throw err
}

function resolveChurnTopN(
	overrideValue: string | undefined,
	defaultValue: number,
): number {
	if (!overrideValue) return defaultValue
	const trimmed = overrideValue.trim()
	const parsed = Number(trimmed)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		const err = new Error(
			`Invalid churnTopN value "${overrideValue}". Use a positive integer.`,
		)
		err.cause = "CONFIG_PROFILE_INVALID"
		throw err
	}
	return parsed
}

function normalizeChurnReportOut(
	value: string | undefined,
): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function resolveChurnHistoryOut(
	overrideValue: string | undefined,
	defaultValue: string,
): string | undefined {
	if (!overrideValue) return defaultValue
	const trimmed = overrideValue.trim()
	if (trimmed.length === 0) return defaultValue
	if (trimmed === "off") return undefined
	return trimmed
}

function reportCoreToMetrics(report: TChurnReportV1): TChurnMetrics {
	const { core } = report
	return {
		totalOldFiles: core.files.totalOld,
		totalNewFiles: core.files.totalNew,
		stableFiles: core.files.stable,
		changedFiles: core.files.changed,
		addedFiles: core.files.added,
		removedFiles: core.files.removed,
		totalOldBytes: core.bytes.totalOld,
		totalNewBytes: core.bytes.totalNew,
		stableBytes: core.bytes.stable,
		changedBytes: core.bytes.changed,
		addedBytes: core.bytes.added,
		removedBytes: core.bytes.removed,
		downloadImpactFilesPercent: core.percent.downloadImpactFiles,
		cacheReuseFilesPercent: core.percent.cacheReuseFiles,
		downloadImpactBytesPercent: core.percent.downloadImpactBytes,
		cacheReuseBytesPercent: core.percent.cacheReuseBytes,
	}
}

async function writeChurnReport(
	report: TChurnReportV1,
	output: string,
): Promise<void> {
	const content = JSON.stringify(report, null, 2) + "\n"
	if (output === "stdout") {
		logPhaseSuccess(content)
		return
	}
	const outputPath = path.resolve(process.cwd(), output)
	await fs.mkdir(path.dirname(outputPath), { recursive: true })
	await fs.writeFile(outputPath, content, "utf8")
	logPhaseSuccess(`Churn report written to ${outputPath}`)
}

async function appendChurnHistory(
	report: TChurnReportV1,
	output: string,
): Promise<void> {
	const diagnostics = report.diagnostics
	const historyRecord = {
		schema: "com.dodefey.churn-history-record",
		schemaVersion: "1.0.0",
		reportId: report.reportId,
		generatedAt: report.generatedAt,
		profile: report.run.profile,
		mode: report.run.mode,
		dryRun: report.run.dryRun,
		baseline: report.baseline,
		core: report.core,
		diagnosticsSummary: diagnostics
			? {
					categories: diagnostics.categories,
					renameNoiseBytes:
						diagnostics.avoidableChurn?.renameNoiseBytes,
					renameNoisePercentOfDownloadBytes:
						diagnostics.avoidableChurn
							?.renameNoisePercentOfDownloadBytes,
				}
			: undefined,
		report,
	}

	const content = JSON.stringify(historyRecord) + "\n"

	if (output === "stdout") {
		logPhaseSuccess(content)
		return
	}

	const outputPath = path.resolve(process.cwd(), output)
	await fs.mkdir(path.dirname(outputPath), { recursive: true })
	await fs.appendFile(outputPath, content, "utf8")
	logPhaseSuccess(`Churn history appended to ${outputPath}`)
}

function installRunLoggerSink(logWriter?: TRunLogWriter): void {
	if (!logWriter) {
		setLoggerSink(null)
		return
	}

	setLoggerSink(
		createCompositeLoggerSink([
			createWriterLoggerSink(logWriter),
			{
				info: (line) => {
					console.log(line)
				},
				error: (line) => {
					console.error(line)
				},
			},
		]),
	)
}

function createPhaseOutputHandlers(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): TPhaseOutputHandlers {
	if (values.verbose) {
		return {
			outputMode: "inherit",
		}
	}

	if (logWriter) {
		return {
			outputMode: "callbacks",
			onStdoutChunk: createFileChunkWriter(logWriter, "stdout"),
			onStderrChunk: createFileChunkWriter(logWriter, "stderr"),
		}
	}

	return {
		outputMode: "silent",
	}
}

function createFileChunkWriter(
	logWriter: TRunLogWriter,
	streamName: "stdout" | "stderr",
): (chunk: string) => void {
	return (chunk: string) => {
		writeDeployLogEvent(logWriter, {
			phase: "deploy",
			kind: "output",
			data: {
				stream: streamName,
				chunk,
			},
		})
		logWriter.writeChunk(chunk)
	}
}

function createTestPhaseOutputHandlers(
	values: TDeployArgs,
	logWriter?: TRunLogWriter,
): TTestPhaseOutputHandlers {
	return createPhaseOutputHandlers(values, logWriter)
}

async function createRunLogWriter(deploy: TDeployArgs): Promise<TRunLogWriter> {
	const outputPath = resolveLogFilePath(deploy)
	await fs.mkdir(path.dirname(outputPath), { recursive: true })
	const logging = resolveLoggingConfig(deploy.logging)

	const stream = createWriteStream(outputPath, {
		flags: logging.file.mode === "append" ? "a" : "w",
		encoding: "utf8",
	})

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			stream.off("error", onError)
			stream.off("open", onOpen)
		}
		const onError = (err: Error) => {
			cleanup()
			reject(err)
		}
		const onOpen = () => {
			cleanup()
			resolve()
		}
		stream.once("error", onError)
		stream.once("open", onOpen)
	})

	return createStreamLogWriter(outputPath, stream)
}

function resolveLogFilePath(deploy: TDeployArgs): string {
	const logging = resolveLoggingConfig(deploy.logging)
	const dir = path.resolve(process.cwd(), logging.file.dir)
	if (logging.file.mode === "append") {
		return path.join(dir, "deploy.log")
	}

	return path.join(
		dir,
		`deploy-${sanitizeFileSegment(deploy.profileName)}-${formatRunTimestamp(new Date())}.log`,
	)
}

function resolveLoggingConfig(
	logging: TResolvedLoggingConfig | undefined,
): TResolvedLoggingConfig {
	return (
		logging ?? {
			console: {
				verboseDefault: false,
			},
			file: {
				enabled: false,
				dir: ".deploy/logs",
				mode: "perRun",
			},
		}
	)
}

function createStreamLogWriter(
	outputPath: string,
	stream: WriteStream,
): TRunLogWriter {
	return {
		path: outputPath,
		writeLine: (line) => {
			stream.write(line + "\n")
		},
		writeChunk: (chunk) => {
			stream.write(chunk)
		},
		writeEvent: (event) => {
			stream.write(`[deploy-record] ${JSON.stringify(event)}\n`)
		},
		close: async () => {
			if (stream.closed || stream.destroyed) return
			await new Promise<void>((resolve, reject) => {
				stream.end((err?: Error | null) => {
					if (err) {
						reject(err)
						return
					}
					resolve()
				})
			})
		},
	}
}

function writeDeployLogEvent(
	logWriter: TRunLogWriter | undefined,
	event: Omit<TDeployLogEvent, "timestamp">,
): void {
	logWriter?.writeEvent({
		timestamp: new Date().toISOString(),
		...event,
	})
}

function writePhaseErrorEvent(
	logWriter: TRunLogWriter | undefined,
	phase: TDeployPhase,
	err: unknown,
): void {
	writeDeployLogEvent(logWriter, {
		phase,
		kind: "error",
		message: toErrorMessage(err),
		data: {
			code: err instanceof Error && typeof err.cause === "string" ? err.cause : undefined,
		},
	})
}

function createDeployVitestArgs(reportPath?: string): string[] {
	const args = ["vitest", "run", "--reporter=default"]
	if (reportPath) {
		args.push("--reporter=json", `--outputFile.json=${reportPath}`)
	}
	return args
}

async function createVitestReportArtifact(): Promise<{
	dir: string
	reportPath: string
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-vitest-"))
	return {
		dir,
		reportPath: path.join(dir, "vitest-report.json"),
	}
}

async function writeVitestReportToDeployLog(
	logWriter: TRunLogWriter | undefined,
	reportPath: string,
): Promise<void> {
	if (!logWriter) return
	try {
		const content = await fs.readFile(reportPath, "utf8")
		const report = JSON.parse(content) as TVitestJsonReport
		writeDeployLogEvent(logWriter, {
			phase: "tests",
			kind: "summary",
			message: "Vitest JSON report",
			data: {
				success: report.success,
				numTotalTestSuites: report.numTotalTestSuites,
				numPassedTestSuites: report.numPassedTestSuites,
				numFailedTestSuites: report.numFailedTestSuites,
				numPendingTestSuites: report.numPendingTestSuites,
				numTotalTests: report.numTotalTests,
				numPassedTests: report.numPassedTests,
				numFailedTests: report.numFailedTests,
				numPendingTests: report.numPendingTests,
				numTodoTests: report.numTodoTests,
			},
		})
		for (const suite of report.testResults ?? []) {
			writeDeployLogEvent(logWriter, {
				phase: "tests",
				kind: "result",
				message: suite.name,
				data: {
					status: suite.status,
					message: suite.message,
				},
			})
			for (const assertion of suite.assertionResults ?? []) {
				writeDeployLogEvent(logWriter, {
					phase: "tests",
					kind: "result",
					message: assertion.fullName,
					data: {
						title: assertion.title,
						status: assertion.status,
						failureMessages: assertion.failureMessages ?? [],
						file: suite.name,
					},
				})
			}
		}
	} catch (err) {
		writeDeployLogEvent(logWriter, {
			phase: "tests",
			kind: "error",
			message: `Failed to read Vitest JSON report: ${toErrorMessage(err)}`,
			data: { reportPath },
		})
	}
}

function sanitizeFileSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-")
}

function formatRunTimestamp(date: Date): string {
	const year = String(date.getFullYear())
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	const hours = String(date.getHours()).padStart(2, "0")
	const minutes = String(date.getMinutes()).padStart(2, "0")
	const seconds = String(date.getSeconds()).padStart(2, "0")
	return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

function handleFatalError(
	label: string,
	err: unknown,
	profileName?: string,
): never {
	logFatalError(label, err, { profileName })
	throw fatalDeployError(err)
}

function fatalDeployError(cause: unknown): Error {
	const err = cause instanceof Error ? cause : new Error(toErrorMessage(cause))
	Object.defineProperty(err, FATAL_DEPLOY_ERROR, {
		value: true,
		enumerable: false,
	})
	return err
}

function isFatalDeployError(err: unknown): boolean {
	return err instanceof Error && FATAL_DEPLOY_ERROR in err
}

// Important: JUST call cli with args + command.
// No custom options object, no extra wrapping around it.
async function main(): Promise<void> {
	try {
		await cli(process.argv.slice(2), deployCommand)
		process.exitCode = 0
	} catch (err) {
		if (!isFatalDeployError(err)) {
			logUnexpectedError(err, { profileName: lastProfileUsed })
		}
		process.exitCode = 1
	}
}

if (!process.env.VITEST) {
	void main()
}

/** @internal Test-only exports */
export const __test__: Record<string, unknown> = {
	selectConfig,
	applyOverrides,
	buildDeployArgs,
	main,
	runBuildPhase,
	runSyncPhase,
	runPm2Phase,
	runChurnPhase,
	runChurnOnlyMode,
	runTestPhase,
	deployCommand,
	handleFatalError,
	createTestPhaseOutputHandlers,
	isFatalDeployError,
	createPhaseOutputHandlers,
	createDeployVitestArgs,
	writeVitestReportToDeployLog,
	resolveLogFilePath,
	formatRunTimestamp,
	noop,
}
