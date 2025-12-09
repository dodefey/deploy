import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface TProfile {
	name: string
	/** SSH target, e.g. "user@host" */
	sshConnectionString: string
	remoteDir: string
	env: string
	pm2AppName: string
	buildDir?: string
	pm2RestartMode?: "startOrReload" | "reboot"
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
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROFILES_PATH_OVERRIDE_ENV = "DEPLOY_PROFILES_PATH"
// Profiles are defined in profiles.json to keep deploy targets out of code.
const PROFILE_FILE_ERROR_MESSAGE =
	"profiles.json is missing, invalid, or empty; expected at least one deploy profile"

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

	return {
		name: profile.name,
		sshConnectionString,
		remoteDir,
		buildDir,
		env,
		pm2AppName,
		pm2RestartMode,
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

// Keep sync loader since deploy CLI runs in a short-lived process.
function resolveProfilesSearchPaths(): string[] {
	const paths: string[] = []
	const overridePath = process.env[PROFILES_PATH_OVERRIDE_ENV]
	if (overridePath) {
		paths.push(
			path.isAbsolute(overridePath)
				? overridePath
				: path.resolve(process.cwd(), overridePath),
		)
	}
	paths.push(path.resolve(process.cwd(), PROFILES_FILENAME))
	const modulePath = path.resolve(MODULE_DIR, PROFILES_FILENAME)
	if (!paths.includes(modulePath)) {
		paths.push(modulePath)
	}
	return paths
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
