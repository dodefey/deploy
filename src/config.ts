import { readFileSync } from "node:fs"
import path from "node:path"

export type TChurnDiagnosticsDefault = "off" | "compact" | "full" | "json"

export interface TChurnGroupRule {
	pattern: string
	group: string
}

export interface TProfileChurnConfig {
	diagnosticsDefault?: TChurnDiagnosticsDefault
	topN?: number
	groupRules?: TChurnGroupRule[]
}

export interface TResolvedChurnConfig {
	diagnosticsDefault: TChurnDiagnosticsDefault
	topN: number
	groupRules: TChurnGroupRule[]
}

export interface TProfileLoggingConsoleConfig {
	verboseDefault?: boolean
}

export interface TProfileLoggingFileConfig {
	enabled?: boolean
	dir?: string
	mode?: "append" | "perRun"
}

export interface TProfileLoggingConfig {
	console?: TProfileLoggingConsoleConfig
	file?: TProfileLoggingFileConfig
}

export type TDeployEventType =
	| "deploy.completed"
	| "deploy.failed"
	| "deploy.degraded"

export interface TProfileHttpWebhookEventSinkConfig {
	type: "http-webhook"
	url: string
	on?: TDeployEventType[]
	timeoutMs?: number
	retries?: number
	fatal?: boolean
	headers?: Record<string, string>
}

export interface TProfileEventsConfig {
	gitSha?: string
	releaseVersion?: string
	sinks?: TProfileHttpWebhookEventSinkConfig[]
}

export interface TResolvedLoggingConfig {
	console: {
		verboseDefault: boolean
	}
	file: {
		enabled: boolean
		dir: string
		mode: "append" | "perRun"
	}
}

export interface TResolvedHttpWebhookEventSinkConfig {
	type: "http-webhook"
	url: string
	on: TDeployEventType[]
	timeoutMs: number
	retries: number
	fatal: boolean
	headers: Record<string, string>
}

export interface TResolvedEventsConfig {
	gitSha?: string
	releaseVersion?: string
	sinks: TResolvedHttpWebhookEventSinkConfig[]
}

export interface TProfile {
	name: string
	/** SSH target, e.g. "user@host" */
	sshConnectionString: string
	remoteDir: string
	env: string
	pm2AppName: string
	buildDir?: string
	pm2RestartMode?: "startOrReload" | "reboot"
	buildCommand?: string
	buildArgs?: string[]
	churn?: TProfileChurnConfig
	logging?: TProfileLoggingConfig
	events?: TProfileEventsConfig
}

export type TProfileName = TProfile["name"]

export interface TResolvedConfig {
	name: TProfile["name"]
	sshConnectionString: string
	remoteDir: string
	buildDir: string
	env: string
	pm2AppName: string
	pm2RestartMode: "startOrReload" | "reboot"
	buildCommand: string
	buildArgs: string[]
	churn: TResolvedChurnConfig
	logging: TResolvedLoggingConfig
	events: TResolvedEventsConfig
}

export type TConfigErrorCode =
	| "CONFIG_PROFILE_NOT_FOUND"
	| "CONFIG_PROFILE_FILE_NOT_FOUND"
	| "CONFIG_DUPLICATE_PROFILE"
	| "CONFIG_PROFILE_INVALID"
	| "CONFIG_INVALID_RESTART_MODE"

type TRequiredProfileStringFieldKey =
	| "sshConnectionString"
	| "remoteDir"
	| "env"
	| "pm2AppName"

const REQUIRED_PROFILE_STRING_FIELDS: ReadonlyArray<{
	key: TRequiredProfileStringFieldKey
}> = [
	{ key: "sshConnectionString" },
	{ key: "remoteDir" },
	{ key: "env" },
	{ key: "pm2AppName" },
]
const PROFILES_FILENAME = "profiles.json"
const PROFILES_PATH_OVERRIDE_ENV = "DEPLOY_PROFILES_PATH"
// Profiles are defined in profiles.json to keep deploy targets out of code.
const PROFILE_FILE_ERROR_MESSAGE =
	"profiles.json is missing, invalid, or empty; expected at least one deploy profile"
const DEFAULT_CHURN_DIAGNOSTICS_MODE: TChurnDiagnosticsDefault = "off"
const DEFAULT_CHURN_TOP_N = 5
const DEFAULT_LOG_FILE_DIR = ".deploy/logs"
const DEFAULT_LOG_FILE_MODE = "perRun" as const
const DEFAULT_EVENT_TYPES: TDeployEventType[] = [
	"deploy.completed",
	"deploy.failed",
	"deploy.degraded",
]
const DEFAULT_EVENT_TIMEOUT_MS = 3000
const DEFAULT_EVENT_RETRIES = 1

let profilesLoader = loadProfilesFromDisk

let profilesSource: TProfile[] | null = null

export function listProfiles(): TProfileName[] {
	return getProfiles().map((p) => p.name)
}

export function resolveProfile(name: TProfileName): TResolvedConfig {
	const profile = getProfiles().find((p) => p.name === name)
	if (!profile) {
		throw configError(
			"CONFIG_PROFILE_NOT_FOUND",
			`Profile not found: ${name}`,
		)
	}

	const { sshConnectionString, remoteDir, env, pm2AppName } =
		validateRequiredProfileFields(profile)

	const buildDir = normalizeOptionalString(profile.buildDir) ?? ".output"
	const pm2RestartMode =
		validateRestartMode(profile.pm2RestartMode) ?? "startOrReload"
	const buildCommand = requireString(
		profile.buildCommand,
		"CONFIG_PROFILE_INVALID",
		"buildCommand",
	)
	const buildArgs = validateBuildArgs(profile.buildArgs)
	const churn = validateChurnConfig(profile.churn)
	const logging = validateLoggingConfig(profile.logging)
	const events = validateEventsConfig(profile.events)

	return {
		name: profile.name,
		sshConnectionString,
		remoteDir,
		buildDir,
		env,
		pm2AppName,
		pm2RestartMode,
		buildCommand,
		buildArgs,
		churn,
		logging,
		events,
	}
}

function requireString(
	value: unknown,
	code: TConfigErrorCode,
	fieldName: string,
): string {
	if (typeof value !== "string") {
		throw configError(code, `Missing required field: ${fieldName}`)
	}
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw configError(code, `Missing required field: ${fieldName}`)
	}
	return trimmed
}

function normalizeOptionalString(value?: string): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function validateRestartMode(
	value?: string,
): "startOrReload" | "reboot" | undefined {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	// Treat empty/whitespace as not provided; default will apply.
	if (trimmed.length === 0) return undefined
	if (trimmed === "startOrReload" || trimmed === "reboot") {
		return trimmed
	}
	throw configError(
		"CONFIG_INVALID_RESTART_MODE",
		`Invalid pm2RestartMode: ${value}`,
	)
}

function ensureUniqueProfileNames(profiles: TProfile[]): void {
	const seen = new Set<string>()
	for (const profile of profiles) {
		const name = profile.name
		if (seen.has(name)) {
			throw configError(
				"CONFIG_DUPLICATE_PROFILE",
				`Duplicate profile name: ${name}`,
			)
		}
		seen.add(name)
	}
}

interface TRequiredProfileFields {
	sshConnectionString: string
	remoteDir: string
	env: string
	pm2AppName: string
}

function validateRequiredProfileFields(
	profile: TProfile,
): TRequiredProfileFields {
	const result = {} as TRequiredProfileFields

	for (const { key } of REQUIRED_PROFILE_STRING_FIELDS) {
		const value = profile[key]
		const validated = requireString(value, "CONFIG_PROFILE_INVALID", key)
		result[key] = validated
	}

	return result
}

function validateBuildArgs(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"Missing required field: buildArgs",
		)
	}

	const normalized: string[] = []
	for (let i = 0; i < value.length; i += 1) {
		const arg = value[i] as unknown
		if (typeof arg !== "string") {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				`buildArgs[${String(i)}] must be a non-empty string`,
			)
		}
		const trimmed = arg.trim()
		if (trimmed.length === 0) {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				"buildArgs must not contain empty values",
			)
		}
		normalized.push(trimmed)
	}

	return normalized
}

function validateChurnConfig(value: unknown): TResolvedChurnConfig {
	if (value === undefined) {
		return {
			diagnosticsDefault: DEFAULT_CHURN_DIAGNOSTICS_MODE,
			topN: DEFAULT_CHURN_TOP_N,
			groupRules: [],
		}
	}

	if (!isRecord(value)) {
		throw configError("CONFIG_PROFILE_INVALID", "churn must be an object")
	}

	const diagnosticsDefault =
		value.diagnosticsDefault === undefined
			? DEFAULT_CHURN_DIAGNOSTICS_MODE
			: validateDiagnosticsDefault(value.diagnosticsDefault)

	const topN =
		value.topN === undefined
			? DEFAULT_CHURN_TOP_N
			: validatePositiveInteger(value.topN, "churn.topN")

	const groupRules =
		value.groupRules === undefined
			? []
			: validateChurnGroupRules(value.groupRules)

	return {
		diagnosticsDefault,
		topN,
		groupRules,
	}
}

function validateLoggingConfig(value: unknown): TResolvedLoggingConfig {
	if (value === undefined) {
		return {
			console: {
				verboseDefault: false,
			},
			file: {
				enabled: false,
				dir: DEFAULT_LOG_FILE_DIR,
				mode: DEFAULT_LOG_FILE_MODE,
			},
		}
	}

	if (!isRecord(value)) {
		throw configError("CONFIG_PROFILE_INVALID", "logging must be an object")
	}

	const consoleConfig =
		value.console === undefined
			? { verboseDefault: false }
			: validateLoggingConsoleConfig(value.console)
	const fileConfig =
		value.file === undefined
			? {
					enabled: false,
					dir: DEFAULT_LOG_FILE_DIR,
					mode: DEFAULT_LOG_FILE_MODE,
				}
			: validateLoggingFileConfig(value.file)

	return {
		console: consoleConfig,
		file: fileConfig,
	}
}

function validateLoggingConsoleConfig(
	value: unknown,
): TResolvedLoggingConfig["console"] {
	if (!isRecord(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"logging.console must be an object",
		)
	}

	if (
		value.verboseDefault !== undefined &&
		typeof value.verboseDefault !== "boolean"
	) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"logging.console.verboseDefault must be a boolean",
		)
	}

	return {
		verboseDefault: value.verboseDefault ?? false,
	}
}

function validateLoggingFileConfig(
	value: unknown,
): TResolvedLoggingConfig["file"] {
	if (!isRecord(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"logging.file must be an object",
		)
	}

	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"logging.file.enabled must be a boolean",
		)
	}

	const dir =
		value.dir === undefined
			? DEFAULT_LOG_FILE_DIR
			: requireString(value.dir, "CONFIG_PROFILE_INVALID", "logging.file.dir")

	const mode =
		value.mode === undefined
			? DEFAULT_LOG_FILE_MODE
			: validateLogFileMode(value.mode)

	return {
		enabled: value.enabled ?? false,
		dir,
		mode,
	}
}

function validateLogFileMode(value: unknown): "append" | "perRun" {
	if (typeof value !== "string") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"logging.file.mode must be one of: append, perRun",
		)
	}

	const trimmed = value.trim()
	if (trimmed === "append" || trimmed === "perRun") {
		return trimmed
	}

	throw configError(
		"CONFIG_PROFILE_INVALID",
		`Invalid logging.file.mode: ${value}`,
	)
}

function validateEventsConfig(value: unknown): TResolvedEventsConfig {
	if (value === undefined) {
		return { sinks: [] }
	}

	if (!isRecord(value)) {
		throw configError("CONFIG_PROFILE_INVALID", "events must be an object")
	}

	const sinks =
		value.sinks === undefined ? [] : validateEventSinks(value.sinks)

	return {
		gitSha: validateOptionalStringField(value.gitSha, "events.gitSha"),
		releaseVersion: validateOptionalStringField(
			value.releaseVersion,
			"events.releaseVersion",
		),
		sinks,
	}
}

function validateEventSinks(
	value: unknown,
): TResolvedHttpWebhookEventSinkConfig[] {
	if (!Array.isArray(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"events.sinks must be an array",
		)
	}

	return value.map((sink, index) => validateEventSink(sink, index))
}

function validateEventSink(
	value: unknown,
	index: number,
): TResolvedHttpWebhookEventSinkConfig {
	if (!isRecord(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`events.sinks[${String(index)}] must be an object`,
		)
	}

	if (value.type !== "http-webhook") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`events.sinks[${String(index)}].type must be "http-webhook"`,
		)
	}

	const on =
		value.on === undefined
			? [...DEFAULT_EVENT_TYPES]
			: validateEventTypeList(value.on, `events.sinks[${String(index)}].on`)

	const timeoutMs =
		value.timeoutMs === undefined
			? DEFAULT_EVENT_TIMEOUT_MS
			: validatePositiveInteger(
					value.timeoutMs,
					`events.sinks[${String(index)}].timeoutMs`,
				)
	const retries =
		value.retries === undefined
			? DEFAULT_EVENT_RETRIES
			: validateNonNegativeInteger(
					value.retries,
					`events.sinks[${String(index)}].retries`,
				)

	if (value.fatal !== undefined && typeof value.fatal !== "boolean") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`events.sinks[${String(index)}].fatal must be a boolean`,
		)
	}

	return {
		type: "http-webhook",
		url: requireString(
			value.url,
			"CONFIG_PROFILE_INVALID",
			`events.sinks[${String(index)}].url`,
		),
		on,
		timeoutMs,
		retries,
		fatal: value.fatal ?? false,
		headers: validateStringRecord(
			value.headers,
			`events.sinks[${String(index)}].headers`,
		),
	}
}

function validateEventTypeList(
	value: unknown,
	fieldName: string,
): TDeployEventType[] {
	if (!Array.isArray(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be an array`,
		)
	}

	const normalized = value.map((item, index) =>
		validateEventType(item, `${fieldName}[${String(index)}]`),
	)
	if (normalized.length === 0) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must not be empty`,
		)
	}
	return normalized
}

function validateEventType(
	value: unknown,
	fieldName: string,
): TDeployEventType {
	if (typeof value !== "string") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be one of: deploy.completed, deploy.failed, deploy.degraded`,
		)
	}

	const trimmed = value.trim()
	if (
		trimmed === "deploy.completed" ||
		trimmed === "deploy.failed" ||
		trimmed === "deploy.degraded"
	) {
		return trimmed
	}

	throw configError(
		"CONFIG_PROFILE_INVALID",
		`Invalid deploy event type: ${value}`,
	)
}

function validateStringRecord(
	value: unknown,
	fieldName: string,
): Record<string, string> {
	if (value === undefined) {
		return {}
	}
	if (!isRecord(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be an object`,
		)
	}

	const result: Record<string, string> = {}
	for (const [key, rawValue] of Object.entries(value)) {
		const trimmedKey = key.trim()
		if (trimmedKey.length === 0) {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				`${fieldName} must not contain empty keys`,
			)
		}
		if (typeof rawValue !== "string") {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				`${fieldName}.${trimmedKey} must be a string`,
			)
		}
		result[trimmedKey] = rawValue
	}

	return result
}

function validateOptionalStringField(
	value: unknown,
	fieldName: string,
): string | undefined {
	if (value === undefined) {
		return undefined
	}
	if (typeof value !== "string") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be a string`,
		)
	}

	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must not be empty`,
		)
	}

	return trimmed
}

function validateDiagnosticsDefault(value: unknown): TChurnDiagnosticsDefault {
	if (typeof value !== "string") {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"churn.diagnosticsDefault must be one of: off, compact, full, json",
		)
	}
	const trimmed = value.trim()
	if (
		trimmed === "off" ||
		trimmed === "compact" ||
		trimmed === "full" ||
		trimmed === "json"
	) {
		return trimmed
	}
	throw configError(
		"CONFIG_PROFILE_INVALID",
		`Invalid churn.diagnosticsDefault: ${value}`,
	)
}

function validatePositiveInteger(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be a positive integer`,
		)
	}
	return value
}

function validateNonNegativeInteger(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			`${fieldName} must be a non-negative integer`,
		)
	}
	return value
}

function validateChurnGroupRules(value: unknown): TChurnGroupRule[] {
	if (!Array.isArray(value)) {
		throw configError(
			"CONFIG_PROFILE_INVALID",
			"churn.groupRules must be an array",
		)
	}

	const rules = value as unknown[]
	const normalized: TChurnGroupRule[] = []
	for (let i = 0; i < rules.length; i += 1) {
		const item = rules[i]
		if (!isRecord(item)) {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				`churn.groupRules[${String(i)}] must be an object`,
			)
		}

		const pattern = normalizeConfigString(item.pattern)
		const group = normalizeConfigString(item.group)

		if (!pattern || !group) {
			throw configError(
				"CONFIG_PROFILE_INVALID",
				`churn.groupRules[${String(i)}] requires non-empty pattern and group`,
			)
		}

		normalized.push({ pattern, group })
	}

	return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeConfigString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

/** @internal test-only */
// Test-only helper to allow injecting profiles under Vitest.
export function __setProfilesForTest(profiles: TProfile[]): void {
	if (!process.env.VITEST) {
		throw new Error("__setProfilesForTest is only available in tests")
	}
	ensureUniqueProfileNames(profiles)
	profilesSource = profiles
}

/** @internal test-only */
export function __resetProfilesCacheForTest(): void {
	if (!process.env.VITEST) {
		throw new Error(
			"__resetProfilesCacheForTest is only available in tests",
		)
	}
	profilesSource = null
}

/** @internal test-only */
export function __setProfilesLoaderForTest(loader: () => unknown): void {
	if (!process.env.VITEST) {
		throw new Error("__setProfilesLoaderForTest is only available in tests")
	}
	profilesLoader = loader
}

/** @internal test-only */
export function __testResolveProfilesSearchPaths(
	overridePath: string | undefined,
	cwd: string,
): string[] {
	return resolveProfilesSearchPathsInternal(overridePath, cwd)
}

/** @internal test-only */
export function __resetProfilesLoaderForTest(): void {
	if (!process.env.VITEST) {
		throw new Error(
			"__resetProfilesLoaderForTest is only available in tests",
		)
	}
	profilesLoader = loadProfilesFromDisk
}

function getProfiles(): TProfile[] {
	if (profilesSource !== null) {
		if (profilesSource.length === 0) {
			throw configError(
				"CONFIG_PROFILE_FILE_NOT_FOUND",
				PROFILE_FILE_ERROR_MESSAGE,
			)
		}
		return profilesSource
	}

	let loaded: unknown
	try {
		loaded = profilesLoader()
	} catch {
		throw configError(
			"CONFIG_PROFILE_FILE_NOT_FOUND",
			PROFILE_FILE_ERROR_MESSAGE,
		)
	}

	const normalized = normalizeProfiles(loaded)
	ensureUniqueProfileNames(normalized)
	profilesSource = normalized
	return profilesSource
}

function normalizeProfiles(source: unknown): TProfile[] {
	if (!Array.isArray(source) || source.length === 0) {
		throw configError(
			"CONFIG_PROFILE_FILE_NOT_FOUND",
			PROFILE_FILE_ERROR_MESSAGE,
		)
	}

	return source as TProfile[]
}

function resolveProfilesSearchPathsInternal(
	overridePath: string | undefined,
	cwd: string,
): string[] {
	const paths: string[] = []
	if (overridePath) {
		paths.push(
			path.isAbsolute(overridePath)
				? overridePath
				: path.resolve(cwd, overridePath),
		)
	}
	paths.push(path.resolve(cwd, PROFILES_FILENAME))
	return paths
}

// Keep sync loader since deploy CLI runs in a short-lived process.
function resolveProfilesSearchPaths(): string[] {
	const overridePath = process.env[PROFILES_PATH_OVERRIDE_ENV]
	const cwd = process.cwd()
	return resolveProfilesSearchPathsInternal(overridePath, cwd)
}

function loadProfilesFromDisk(): unknown {
	for (const candidatePath of resolveProfilesSearchPaths()) {
		try {
			const json = readFileSync(candidatePath, "utf8")
			return JSON.parse(json)
		} catch {
			continue
		}
	}

	throw configError(
		"CONFIG_PROFILE_FILE_NOT_FOUND",
		PROFILE_FILE_ERROR_MESSAGE,
	)
}

function configError(code: TConfigErrorCode, message: string): Error {
	const err = new Error(message)
	err.cause = code
	return err
}
