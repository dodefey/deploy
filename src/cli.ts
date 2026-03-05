#!/usr/bin/env node

import { cli, define } from "gunshi"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import type { TBuildOutputMode } from "./build.js"
import { runBuild } from "./build.js"
import type { TChurnMetrics } from "./churn.js"
import { computeClientChurnReport } from "./churn.js"
import { formatChurnReportDiagnostics } from "./churnDiagnosticsFormat.js"
import type { TChurnReportV1 } from "./churnSchema.js"
import type { TConfigErrorCode, TResolvedConfig } from "./config.js"
import { listProfiles, resolveProfile } from "./config.js"
import {
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
	toErrorMessage,
} from "./deployLogging.js"
import { updatePM2App } from "./pm2.js"
import { syncBuild } from "./syncBuild.js"
import { runTests } from "./test.js"

// Exit semantics:
// - Fatal phases: configuration, tests, build, sync, churn-only (exit 1 via handleFatalError).
// - Non-fatal phases: PM2 and churn (full deploy) log errors; exit code stays 0 if fatal phases succeed.
// - main() calls process.exit(0) on success; process.exit(1) on unexpected errors.

const noop = (): void => {}
let lastProfileUsed: string | undefined

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
	churnDiagnostics?: TChurnDiagnosticsMode
	churnTopN?: number
	churnReportOut?: string
	churnGroupRules?: Array<{ pattern: string; group: string }>
}

type TChurnDiagnosticsMode = "off" | "compact" | "full" | "json"
type TResolvedConfigWithOptionalChurn = Omit<TResolvedConfig, "churn"> & {
	churn?: TResolvedConfig["churn"]
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
			profile?: string
		}

		let deploy: TDeployArgs
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
			})
			lastProfileUsed = deploy.profileName
		} catch (err) {
			handleFatalError("Configuration", err, values.profile)
		}

		if (deploy.churnOnly) {
			await runChurnOnlyMode(deploy)
			return
		}

		logDeployStart({ profileName: deploy.profileName })

		await runTestPhase(deploy)

		await runBuildPhase(deploy)
		await runSyncPhase(deploy)
		await runPm2Phase(deploy)
		await runChurnPhase(deploy)
		logDeploySuccess({ profileName: deploy.profileName })
		return
	},
})

async function runBuildPhase(values: TDeployArgs): Promise<void> {
	logPhaseStart("Running build")
	if (values.skipBuild) {
		logPhaseSuccess("Build skipped (per --skipBuild / -k).")
		return
	}
	try {
		await runBuild(
			{
				command: values.buildCommand,
				args: values.buildArgs,
			},
			{
				rootDir: process.cwd(),
				outputMode: values.verbose ? "inherit" : "callbacks",
				onStdoutLine: values.verbose ? undefined : noop,
				onStderrLine: values.verbose ? undefined : noop,
			},
		)
		logPhaseSuccess("Build completed successfully.")
	} catch (err) {
		handleFatalError("Build", err, values.profileName)
	}
}

async function runTestPhase(values: TDeployArgs): Promise<void> {
	logPhaseStart("Running test suite")
	if (values.skipTests) {
		logPhaseSuccess("Test suite skipped (per --skipTests / -T).")
		return
	}
	try {
		await runTests({
			outputMode: values.verbose ? "inherit" : "callbacks",
			onStdoutLine: values.verbose ? undefined : noop,
			onStderrLine: values.verbose ? undefined : noop,
		})
		logPhaseSuccess("Test suite completed successfully.")
	} catch (err) {
		handleFatalError("Tests", err, values.profileName)
	}
}

async function runSyncPhase(values: TDeployArgs): Promise<void> {
	logPhaseStart("Syncing client bundle to server")
	const options = {
		sshConnectionString: values.sshConnectionString,
		remoteDir: values.remoteDir,
		localOutputDir: values.buildDir,
		dryRun: values.dryRun,
		outputMode: (values.verbose
			? "inherit"
			: "callbacks") as TBuildOutputMode,
		onStdoutLine: values.verbose ? undefined : noop,
		onStderrLine: values.verbose ? undefined : noop,
	}

	try {
		await syncBuild(options)
		logPhaseSuccess("Client bundle sync complete.")
	} catch (err) {
		handleFatalError("Build sync", err, values.profileName)
	}
}

async function runPm2Phase(values: TDeployArgs): Promise<void> {
	logPhaseStart(`Updating PM2 app "${values.pm2AppName}"`)
	if (values.dryRun) {
		logPhaseSuccess("PM2 update complete: skipped.")
		return
	}

	try {
		const result = await updatePM2App({
			sshConnectionString: values.sshConnectionString,
			remoteDir: values.remoteDir,
			appName: values.pm2AppName,
			env: values.env,
			restartMode: values.pm2RestartMode,
			outputMode: values.verbose ? "inherit" : "callbacks",
			onStdoutLine: values.verbose ? undefined : noop,
			onStderrLine: values.verbose ? undefined : noop,
		})
		logPm2Success({
			appName: values.pm2AppName,
			restartMode: values.pm2RestartMode,
			instanceCount: result.instanceCount,
			profileName: values.profileName,
		})
	} catch (err) {
		if (err instanceof Error && err.cause === "PM2_APP_NAME_NOT_FOUND") {
			handleFatalError("PM2 update", err, values.profileName)
		} else {
			logNonFatalError("PM2 update", err, {
				profileName: values.profileName,
			})
		}
	}
}

async function runChurnPhase(values: TDeployArgs): Promise<void> {
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

async function runChurnOnlyMode(values: TDeployArgs): Promise<void> {
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
	},
): TDeployArgs {
	const churnDefaults = merged.churn ?? {
		diagnosticsDefault: "off" as const,
		topN: 5,
		groupRules: [],
	}

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
		verbose: values.verbose,
		churnOnly: values.churnOnly,
		profileName: merged.name,
		churnDiagnostics: resolveChurnDiagnosticsMode(
			values.churnDiagnostics,
			churnDefaults.diagnosticsDefault,
		),
		churnTopN: resolveChurnTopN(values.churnTopN, churnDefaults.topN),
		churnReportOut: normalizeChurnReportOut(values.churnReportOut),
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

function handleFatalError(
	label: string,
	err: unknown,
	profileName?: string,
): never {
	logFatalError(label, err, { profileName })
	process.exit(1)
}

// Important: JUST call cli with args + command.
// No custom options object, no extra wrapping around it.
async function main(): Promise<void> {
	try {
		await cli(process.argv.slice(2), deployCommand)
		process.exit(0)
	} catch (err) {
		logUnexpectedError(err, { profileName: lastProfileUsed })
		process.exit(1)
	}
}

if (!process.env.VITEST) {
	void main()
}

/** @internal Test-only exports */
export const __test__ = {
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
	noop,
}
