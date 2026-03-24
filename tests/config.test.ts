import { beforeEach, describe, expect, it } from "vitest"
import {
	__resetProfilesCacheForTest,
	__resetProfilesLoaderForTest,
	__setProfilesForTest,
	__setProfilesLoaderForTest,
	__testResolveProfilesSearchPaths,
	listProfiles,
	resolveProfile,
	type TProfile,
} from "../src/config"

function expectCause(fn: () => unknown, cause: string) {
	let caught: any
	try {
		fn()
	} catch (err) {
		caught = err
	}
	if (!caught) {
		throw new Error("Expected function to throw, but it did not")
	}
	expect(caught?.cause).toBe(cause)
}

beforeEach(() => {
	__resetProfilesLoaderForTest()
	__setProfilesLoaderForTest(() => {
		throw new Error("test loader should be overridden")
	})
	__resetProfilesCacheForTest()
})

describe("config module", () => {
	it("throws when no profiles are set (empty profiles.json)", () => {
		__setProfilesForTest([])
		expectCause(() => listProfiles(), "CONFIG_PROFILE_FILE_NOT_FOUND")
	})

	it("maps missing profiles.json to CONFIG_PROFILE_FILE_NOT_FOUND", () => {
		__resetProfilesCacheForTest()
		expectCause(() => listProfiles(), "CONFIG_PROFILE_FILE_NOT_FOUND")
	})

	it("maps empty profiles.json content to CONFIG_PROFILE_FILE_NOT_FOUND", () => {
		__resetProfilesCacheForTest()
		__setProfilesLoaderForTest(() => [])
		expectCause(() => listProfiles(), "CONFIG_PROFILE_FILE_NOT_FOUND")
	})

	it("maps loader exceptions to CONFIG_PROFILE_FILE_NOT_FOUND", () => {
		__resetProfilesCacheForTest()
		__setProfilesLoaderForTest(() => {
			throw new Error("boom")
		})
		expectCause(() => listProfiles(), "CONFIG_PROFILE_FILE_NOT_FOUND")
	})

	it("throws when resolving with no profiles", () => {
		__setProfilesForTest([])
		expectCause(
			() => resolveProfile("any"),
			"CONFIG_PROFILE_FILE_NOT_FOUND",
		)
	})

	it("returns profile names from listProfiles", () => {
		const profiles = [
			{
				name: "test",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
			{
				name: "prod",
				sshConnectionString: "s2",
				remoteDir: "/r2",
				env: "e2",
				pm2AppName: "app2",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expect(listProfiles()).toEqual(["test", "prod"])
	})

	it("throws on missing profile", () => {
		const profiles = [
			{
				name: "test",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_NOT_FOUND")
	})

	it("applies defaults for buildDir and pm2RestartMode", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		const resolved = resolveProfile("prod")
		expect(resolved.buildDir).toBe(".output")
		expect(resolved.pm2RestartMode).toBe("startOrReload")
		expect(resolved.buildCommand).toBe("npx")
		expect(resolved.buildArgs).toEqual(["nuxt", "build"])
		expect(resolved.churn).toEqual({
			diagnosticsDefault: "off",
			topN: 5,
			groupRules: [],
		})
		expect(resolved.logging).toEqual({
			console: {
				verboseDefault: false,
			},
			file: {
				enabled: false,
				dir: ".deploy/logs",
				mode: "perRun",
			},
		})
		expect(resolved.events).toEqual({
			sinks: [],
		})
	})

	it("resolves optional logging config with validated values", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				logging: {
					console: {
						verboseDefault: true,
					},
					file: {
						enabled: true,
						dir: "logs/deploy",
						mode: "append",
					},
				},
			},
		]
		__setProfilesForTest(profiles)

		const resolved = resolveProfile("prod")
		expect(resolved.logging).toEqual({
			console: {
				verboseDefault: true,
			},
			file: {
				enabled: true,
				dir: "logs/deploy",
				mode: "append",
			},
		})
	})

	it("throws CONFIG_PROFILE_INVALID for malformed logging config", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				logging: "bad" as unknown as TProfile["logging"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID for invalid logging.file.mode", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				logging: {
					file: {
						// @ts-expect-error intentional invalid value for validation test
						mode: "rotate",
					},
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID for empty logging.file.dir", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				logging: {
					file: {
						dir: "   ",
					},
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("resolves optional event sink config with validated values", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [
						{
							type: "http-webhook",
							url: "http://127.0.0.1:4000/hooks/deploy",
							on: ["deploy.completed", "deploy.failed"],
							timeoutMs: 1500,
							retries: 2,
							fatal: true,
							headers: {
								authorization: "Bearer token",
							},
						},
					],
				},
			},
		]
		__setProfilesForTest(profiles)

		const resolved = resolveProfile("prod")
		expect(resolved.events).toEqual({
			gitSha: "abc1234",
			releaseVersion: "v1.2.3",
			sinks: [
				{
					type: "http-webhook",
					url: "http://127.0.0.1:4000/hooks/deploy",
					on: ["deploy.completed", "deploy.failed"],
					timeoutMs: 1500,
					retries: 2,
					fatal: true,
					headers: {
						authorization: "Bearer token",
					},
				},
			],
		})
	})

	it("defaults event sink selection and delivery settings", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				events: {
					sinks: [
						{
							type: "http-webhook",
							url: "http://127.0.0.1:4000/hooks/deploy",
						},
					],
				},
			},
		]
		__setProfilesForTest(profiles)

		const resolved = resolveProfile("prod")
		expect(resolved.events).toEqual({
			sinks: [
				{
					type: "http-webhook",
					url: "http://127.0.0.1:4000/hooks/deploy",
					on: [
						"deploy.completed",
						"deploy.failed",
						"deploy.degraded",
					],
					timeoutMs: 3000,
					retries: 1,
					fatal: false,
					headers: {},
				},
			],
		})
	})

	it("trims optional event metadata strings", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				events: {
					gitSha: "  abc1234  ",
					releaseVersion: "  v1.2.3  ",
				},
			},
		]
		__setProfilesForTest(profiles)

		const resolved = resolveProfile("prod")
		expect(resolved.events).toEqual({
			gitSha: "abc1234",
			releaseVersion: "v1.2.3",
			sinks: [],
		})
	})

	it("throws CONFIG_PROFILE_INVALID for malformed events config", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				events: "bad" as unknown as TProfile["events"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID for invalid event types", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				events: {
					sinks: [
						{
							type: "http-webhook",
							url: "http://127.0.0.1:4000/hooks/deploy",
							on: [
								"deploy.completed",
								// @ts-expect-error intentional invalid value for validation test
								"deploy.started",
							],
						},
					],
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("resolves optional churn config with validated values", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				churn: {
					diagnosticsDefault: "full",
					topN: 10,
					groupRules: [
						{ pattern: "vendor/**", group: "vendor" },
						{ pattern: "pages/**", group: "page" },
					],
				},
			},
		]
		__setProfilesForTest(profiles)

		const resolved = resolveProfile("prod")
		expect(resolved.churn).toEqual({
			diagnosticsDefault: "full",
			topN: 10,
			groupRules: [
				{ pattern: "vendor/**", group: "vendor" },
				{ pattern: "pages/**", group: "page" },
			],
		})
	})

	it("throws CONFIG_PROFILE_INVALID for invalid churn diagnosticsDefault", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				churn: {
					// @ts-expect-error intentional invalid value for validation test
					diagnosticsDefault: "verbose",
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID for invalid churn.topN", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				churn: {
					topN: 0,
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID for malformed churn.groupRules", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				churn: {
					groupRules: [{ pattern: "vendor/**", group: "   " }],
				},
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("validates all required fields for a matching profile", () => {
		__resetProfilesCacheForTest()
		__setProfilesForTest([
			{
				name: "test",
				sshConnectionString: "  testuser@testhost.example.com  ",
				remoteDir: "  /var/www/test  ",
				env: "  production  ",
				pm2AppName: "  TestApp  ",
				buildCommand: "  npx  ",
				buildArgs: ["  nuxt  ", " build "],
			},
		])

		const resolved = resolveProfile("test")

		expect(resolved.sshConnectionString).toBe(
			"testuser@testhost.example.com",
		)
		expect(resolved.remoteDir).toBe("/var/www/test")
		expect(resolved.env).toBe("production")
		expect(resolved.pm2AppName).toBe("TestApp")
		expect(resolved.buildCommand).toBe("npx")
		expect(resolved.buildArgs).toEqual(["nuxt", "build"])
	})

	it("validates required fields (empty -> missing)", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "   ",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when sshConnectionString is missing", () => {
		__resetProfilesCacheForTest()
		__setProfilesForTest([
			{
				name: "bad",
				remoteDir: "/var/www/test",
				env: "production",
				pm2AppName: "TestApp",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			} as unknown as TProfile,
		])

		expectCause(() => resolveProfile("bad"), "CONFIG_PROFILE_INVALID")
	})

	it("validates required remoteDir", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "   ",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when remoteDir is missing", () => {
		__resetProfilesCacheForTest()
		__setProfilesForTest([
			{
				name: "bad",
				sshConnectionString: "testuser@testhost.example.com",
				env: "production",
				pm2AppName: "TestApp",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			} as unknown as TProfile,
		])

		expectCause(() => resolveProfile("bad"), "CONFIG_PROFILE_INVALID")
	})

	it("validates required env", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "   ",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when env is missing", () => {
		__resetProfilesCacheForTest()
		__setProfilesForTest([
			{
				name: "bad",
				sshConnectionString: "testuser@testhost.example.com",
				remoteDir: "/var/www/test",
				pm2AppName: "TestApp",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			} as unknown as TProfile,
		])

		expectCause(() => resolveProfile("bad"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when buildCommand is missing or empty", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "   ",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when buildArgs are missing or empty", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: [],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("validates required pm2AppName", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "   ",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_PROFILE_INVALID")
	})

	it("throws CONFIG_PROFILE_INVALID when pm2AppName is missing", () => {
		__resetProfilesCacheForTest()
		__setProfilesForTest([
			{
				name: "bad",
				sshConnectionString: "testuser@testhost.example.com",
				remoteDir: "/var/www/test",
				env: "production",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			} as unknown as TProfile,
		])

		expectCause(() => resolveProfile("bad"), "CONFIG_PROFILE_INVALID")
	})

	it("treats empty buildDir as default", () => {
		const profiles = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildDir: "   ",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		__setProfilesForTest(profiles)
		const resolved = resolveProfile("prod")
		expect(resolved.buildDir).toBe(".output")
	})

	it("validates pm2RestartMode values and trims whitespace", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				// @ts-expect-error intentionally supplying padded value to verify trimming
				pm2RestartMode: " reboot ",
			},
		]
		__setProfilesForTest(profiles)
		const resolved = resolveProfile("prod")
		expect(resolved.pm2RestartMode).toBe("reboot")
	})

	it("treats empty pm2RestartMode as default", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				// @ts-expect-error intentionally supplying padded value to verify defaulting
				pm2RestartMode: "   ",
			},
		]
		__setProfilesForTest(profiles)
		const resolved = resolveProfile("prod")
		expect(resolved.pm2RestartMode).toBe("startOrReload")
	})

	it("throws on invalid pm2RestartMode", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				// @ts-expect-error intentionally invalid restart mode to assert error mapping
				pm2RestartMode: "invalid",
			},
		]
		__setProfilesForTest(profiles)
		expectCause(() => resolveProfile("prod"), "CONFIG_INVALID_RESTART_MODE")
	})

	it("trims required fields before returning resolved config", () => {
		const profiles: TProfile[] = [
			{
				name: "prod",
				sshConnectionString: "  testhost ",
				remoteDir: " /var/www ",
				env: " production ",
				pm2AppName: " TestApp ",
				buildDir: "  .output/custom  ",
				buildCommand: " npx ",
				buildArgs: [" nuxt ", " build "],
				// @ts-expect-error padded value to verify trimming/defaulting in resolved config
				pm2RestartMode: " startOrReload ",
			},
		]
		__setProfilesForTest(profiles)
		const resolved = resolveProfile("prod")
		expect(resolved.sshConnectionString).toBe("testhost")
		expect(resolved.remoteDir).toBe("/var/www")
		expect(resolved.env).toBe("production")
		expect(resolved.pm2AppName).toBe("TestApp")
		expect(resolved.buildDir).toBe(".output/custom")
		expect(resolved.buildCommand).toBe("npx")
		expect(resolved.buildArgs).toEqual(["nuxt", "build"])
		expect(resolved.pm2RestartMode).toBe("startOrReload")
	})

	it("throws on duplicate profile names at load time", async () => {
		const profiles = [
			{
				name: "dup",
				sshConnectionString: "s",
				remoteDir: "/r",
				env: "e",
				pm2AppName: "app",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
			{
				name: "dup",
				sshConnectionString: "s2",
				remoteDir: "/r2",
				env: "e2",
				pm2AppName: "app2",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
			},
		]
		expectCause(
			() => __setProfilesForTest(profiles),
			"CONFIG_DUPLICATE_PROFILE",
		)
	})

	describe("profiles search paths", () => {
		it("uses DEPLOY_PROFILES_PATH when absolute and then cwd/profiles.json", () => {
			const cwd = "/project/root"
			const override = "/custom/config/profiles.json"

			const result = __testResolveProfilesSearchPaths(override, cwd)

			expect(result).toEqual([
				"/custom/config/profiles.json",
				"/project/root/profiles.json",
			])
		})

		it("resolves relative DEPLOY_PROFILES_PATH against cwd", () => {
			const cwd = "/project/root"
			const override = "config/profiles.json"

			const result = __testResolveProfilesSearchPaths(override, cwd)

			expect(result).toEqual([
				"/project/root/config/profiles.json",
				"/project/root/profiles.json",
			])
		})

		it("uses only cwd/profiles.json when no override is set", () => {
			const cwd = "/project/root"

			const result = __testResolveProfilesSearchPaths(undefined, cwd)

			expect(result).toEqual(["/project/root/profiles.json"])
		})
	})
})
