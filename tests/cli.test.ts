import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"

type MockConfig = {
	listProfilesReturn?: string[]
	resolveProfileImpl?: () => any
	updatePm2AppImpl?: () => any
	runBuildImpl?: () => any
	runTestsImpl?: () => any
	syncBuildImpl?: () => any
	computeClientChurnReportImpl?: () => any
	formatChurnReportDiagnosticsImpl?: () => any
	gunshiCliImpl?: () => any
}

function buildReportFixture() {
	return {
		schema: "com.dodefey.churn-report",
		schemaVersion: "1.0.0",
		metricSetVersion: "core-1",
		reportId: "report-1",
		generatedAt: "2026-03-05T16:00:02Z",
		producer: {
			name: "@dodefey/deploy",
			version: "0.2.0",
		},
		run: {
			profile: "p",
			mode: "deploy",
			dryRun: false,
		},
		baseline: {
			available: true,
			kind: "previous_deploy",
			distance: 1,
		},
		capabilities: {
			hashDiff: true,
			renameDetection: "hash-match",
			assetTyping: "extension",
			ownerGrouping: "heuristic",
		},
		core: {
			files: {
				totalOld: 10,
				totalNew: 12,
				stable: 5,
				changed: 2,
				added: 3,
				removed: 1,
			},
			bytes: {
				totalOld: 1000,
				totalNew: 1500,
				stable: 500,
				changed: 300,
				added: 700,
				removed: 200,
			},
			percent: {
				downloadImpactFiles: 41.7,
				cacheReuseFiles: 58.3,
				downloadImpactBytes: 66.7,
				cacheReuseBytes: 33.3,
			},
		},
		diagnostics: {
			categories: {
				reused_exact: { files: 5, bytes: 500 },
				changed_same_path: { files: 2, bytes: 300 },
				renamed_same_hash: { files: 2, bytes: 400 },
				new_content: { files: 3, bytes: 700 },
				removed: { files: 1, bytes: 200 },
			},
		},
		quality: {
			comparableClass: "core-1+hash",
			warnings: [],
		},
	}
}

function setupMocks(config: MockConfig = {}) {
	const publishDeployEvent = vi.fn().mockResolvedValue(undefined)
	const logFns = {
		createCompositeLoggerSink: vi.fn((sinks) => ({
			info: (line: string) =>
				sinks.forEach((sink: any) => sink.info(line)),
			error: (line: string) =>
				sinks.forEach((sink: any) => sink.error(line)),
		})),
		createWriterLoggerSink: vi.fn((writer) => ({
			info: (line: string) => writer.writeLine(line),
			error: (line: string) => writer.writeLine(line),
		})),
		logChurnOnlyStart: vi.fn(),
		logChurnOnlySuccess: vi.fn(),
		logChurnSummary: vi.fn(),
		logDeployStart: vi.fn(),
		logDeploySuccess: vi.fn(),
		logFatalError: vi.fn(),
		logNonFatalError: vi.fn(),
		logPhaseStart: vi.fn(),
		logPhaseSuccess: vi.fn(),
		logPm2Success: vi.fn(),
		logUnexpectedError: vi.fn(),
		setLoggerSink: vi.fn(),
		toErrorMessage: (err: unknown) =>
			err instanceof Error ? err.message : String(err),
	}

	const listProfiles = vi
		.fn()
		.mockReturnValue(config.listProfilesReturn ?? [])
	const resolveProfile = vi.fn().mockImplementation(
		config.resolveProfileImpl ??
			(() => {
				throw new Error("resolveProfile not mocked")
			}),
	)
	const runTests = vi
		.fn()
		.mockImplementation(config.runTestsImpl ?? (() => Promise.resolve()))

	vi.doMock("./../src/deployLogging.ts", () => logFns)
	vi.doMock("./../src/config.ts", () => ({
		listProfiles,
		resolveProfile,
	}))
	vi.doMock("./../src/deployEvents.ts", () => ({
		publishDeployEvent,
	}))
	vi.doMock("./../src/build.ts", () => ({
		runBuild: vi
			.fn()
			.mockImplementation(
				config.runBuildImpl ?? (() => Promise.resolve()),
			),
	}))
	vi.doMock("./../src/test.ts", () => ({
		runTests,
	}))
	vi.doMock("./../src/syncBuild.ts", () => ({
		syncBuild: vi
			.fn()
			.mockImplementation(
				config.syncBuildImpl ?? (() => Promise.resolve()),
			),
	}))
	vi.doMock("./../src/pm2.ts", () => ({
		updatePM2App: vi
			.fn()
			.mockImplementation(
				config.updatePm2AppImpl ?? (() => Promise.resolve()),
			),
	}))
	vi.doMock("./../src/churn.ts", () => ({
		computeClientChurnReport: vi
			.fn()
			.mockImplementation(
				config.computeClientChurnReportImpl ??
					(() => Promise.resolve(buildReportFixture())),
			),
	}))
	vi.doMock("./../src/churnDiagnosticsFormat.ts", () => ({
		formatChurnReportDiagnostics: vi
			.fn()
			.mockImplementation(
				config.formatChurnReportDiagnosticsImpl ??
					(() => "formatted diagnostics"),
			),
	}))
	vi.doMock("gunshi", () => ({
		define: vi.fn((def) => def),
		cli: vi
			.fn()
			.mockImplementation(
				config.gunshiCliImpl ?? (() => Promise.resolve(undefined)),
			),
	}))

	return {
		logFns,
		listProfiles,
		resolveProfile,
		runTests,
		publishDeployEvent,
	}
}

async function importMain() {
	return await import("../src/cli")
}

describe("src/cli.ts wiring", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("selectConfig throws when no profiles", async () => {
		setupMocks({ listProfilesReturn: [] })
		const { __test__ } = await importMain()

		expect(() => __test__.selectConfig("test", false)).toThrowError(
			expect.objectContaining({ cause: "CONFIG_PROFILE_FILE_NOT_FOUND" }),
		)
	})

	it("selectConfig throws when profile missing", async () => {
		setupMocks({ listProfilesReturn: ["one"] })
		const { __test__ } = await importMain()

		expect(() => __test__.selectConfig(undefined, false)).toThrowError(
			expect.objectContaining({ cause: "CONFIG_PROFILE_NOT_FOUND" }),
		)
	})

	it("selectConfig returns resolved profile and logs when verbose", async () => {
		const resolved = {
			name: "test",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
		}
		const { logFns, resolveProfile } = setupMocks({
			listProfilesReturn: ["test"],
			resolveProfileImpl: () => resolved,
		})
		const { __test__ } = await importMain()

		const result = __test__.selectConfig("test", true)
		expect(result).toEqual(resolved)
		expect(resolveProfile).toHaveBeenCalledWith("test")
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			'Using profile "test" from profiles.json',
		)
	})

	it("selectConfig wraps config errors with code", async () => {
		setupMocks({
			listProfilesReturn: ["test"],
			resolveProfileImpl: () => {
				const err: any = new Error("boom")
				err.cause = "CONFIG_PROFILE_INVALID"
				throw err
			},
		})
		const { __test__ } = await importMain()

		expect(() => __test__.selectConfig("test", false)).toThrowError(
			expect.objectContaining({
				cause: "CONFIG_PROFILE_INVALID",
				message: expect.stringContaining(
					"Config error [CONFIG_PROFILE_INVALID]",
				),
			}),
		)
	})

	it("applyOverrides rejects bad restartMode", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			churn: {
				diagnosticsDefault: "off" as const,
				topN: 5,
				groupRules: [],
			},
		}

		expect(() =>
			__test__.applyOverrides(cfg, { pm2RestartMode: "bad" }),
		).toThrowError(
			expect.objectContaining({ cause: "CONFIG_INVALID_RESTART_MODE" }),
		)
	})

	it("applyOverrides prefers non-empty overrides", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			churn: {
				diagnosticsDefault: "off" as const,
				topN: 5,
				groupRules: [],
			},
		}
		const overrides = {
			sshConnectionString: " s2 ",
			remoteDir: " /r2 ",
			buildDir: " /b2 ",
			env: " e2 ",
			pm2AppName: " app2 ",
			pm2RestartMode: "reboot",
		}
		const merged = __test__.applyOverrides(cfg, overrides)
		expect(merged).toMatchObject({
			sshConnectionString: "s2",
			remoteDir: "/r2",
			buildDir: "/b2",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "e2",
			pm2AppName: "app2",
			pm2RestartMode: "reboot",
		})
	})

	it("buildDeployArgs copies config and flags", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
		}
		const args = __test__.buildDeployArgs(cfg, {
			dryRun: true,
			skipTests: false,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
		})
		expect(args).toMatchObject({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: true,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})
		expect(args.logging).toEqual({
			console: {
				verboseDefault: false,
			},
			file: {
				enabled: false,
				dir: ".deploy/logs",
				mode: "perRun",
			},
		})
	})

	it("buildDeployArgs applies churn defaults and parses churn overrides", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			churn: {
				diagnosticsDefault: "compact" as const,
				topN: 7,
				groupRules: [],
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			churnDiagnostics: "full",
			churnTopN: "3",
			churnReportOut: "  ./reports/churn.json  ",
		})

		expect(args.churnDiagnostics).toBe("full")
		expect(args.churnTopN).toBe(3)
		expect(args.churnReportOut).toBe("./reports/churn.json")
		expect(args.churnHistoryOut).toBe(".deploy/churn-history.jsonl")
		expect(args.churnGroupRules).toEqual([])
	})

	it("buildDeployArgs enables verbose from profile logging.console.verboseDefault", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			logging: {
				console: {
					verboseDefault: true,
				},
				file: {
					enabled: true,
					dir: "./logs",
					mode: "append" as const,
				},
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
		})

		expect(args.verbose).toBe(true)
		expect(args.logging).toEqual(cfg.logging)
	})

	it("buildDeployArgs resolves event metadata from env when profile omits it", async () => {
		setupMocks()
		vi.stubEnv("DEPLOY_GIT_SHA", "abc1234")
		vi.stubEnv("DEPLOY_RELEASE_VERSION", "v1.2.3")
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			events: {
				sinks: [],
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
		})

		expect(args.events).toEqual({
			gitSha: "abc1234",
			releaseVersion: "v1.2.3",
			sinks: [],
		})
	})

	it("buildDeployArgs prefers profile event metadata over env values", async () => {
		setupMocks()
		vi.stubEnv("DEPLOY_GIT_SHA", "env-sha")
		vi.stubEnv("DEPLOY_RELEASE_VERSION", "env-release")
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			events: {
				gitSha: "profile-sha",
				releaseVersion: "profile-release",
				sinks: [],
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
		})

		expect(args.events).toEqual({
			gitSha: "profile-sha",
			releaseVersion: "profile-release",
			sinks: [],
		})
	})

	it("createPhaseOutputHandlers suppresses child output when quiet and file logging is disabled", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockReturnValue(true as any)
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true as any)
		const handlers = __test__.createPhaseOutputHandlers({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(handlers.outputMode).toBe("silent")
		expect(handlers.onStdoutChunk).toBeUndefined()
		expect(handlers.onStderrChunk).toBeUndefined()
		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
	})

	it("createPhaseOutputHandlers writes child output only to file when quiet and file logging is enabled", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockReturnValue(true as any)
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true as any)
		const chunks: string[] = []

		const handlers = __test__.createPhaseOutputHandlers(
			{
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: false,
				profileName: "p",
			},
			{
				path: "/tmp/test.log",
				writeLine: (line) => chunks.push(line),
				writeChunk: (chunk) => chunks.push(chunk),
				writeEvent: () => {},
				close: () => Promise.resolve(),
			},
		)

		handlers.onStdoutChunk("hello\n")
		handlers.onStderrChunk("oops\n")

		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
		expect(chunks).toEqual(["hello\n", "oops\n"])
	})

	it("createPhaseOutputHandlers uses inherit mode when verbose is true", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockReturnValue(true as any)
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true as any)
		const handlers = __test__.createPhaseOutputHandlers(
			{
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: true,
				churnOnly: false,
				profileName: "p",
			},
			{
				path: "/tmp/test.log",
				writeLine: () => {},
				writeChunk: () => {},
				writeEvent: () => {},
				close: () => Promise.resolve(),
			},
		)

		expect(handlers.outputMode).toBe("inherit")
		expect(handlers.onStdoutChunk).toBeUndefined()
		expect(handlers.onStderrChunk).toBeUndefined()
		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
	})

	it("resolveLogFilePath uses append and perRun naming conventions", async () => {
		setupMocks()
		const { __test__ } = await importMain()

		const appendPath = __test__.resolveLogFilePath({
			profileName: "prod",
			logging: {
				console: { verboseDefault: false },
				file: {
					enabled: true,
					dir: ".deploy/logs",
					mode: "append",
				},
			},
		})
		const perRunPath = __test__.resolveLogFilePath({
			profileName: "prod site",
			logging: {
				console: { verboseDefault: false },
				file: {
					enabled: true,
					dir: ".deploy/logs",
					mode: "perRun",
				},
			},
		})

		expect(appendPath).toContain(path.join(".deploy", "logs", "deploy.log"))
		expect(perRunPath).toMatch(/deploy-prod-site-\d{8}-\d{6}\.log$/)
	})

	it("buildDeployArgs normalizes churnHistoryOut override", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			churn: {
				diagnosticsDefault: "off" as const,
				topN: 5,
				groupRules: [],
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			churnHistoryOut: "  ./reports/churn-history.jsonl  ",
		})

		expect(args.churnHistoryOut).toBe("./reports/churn-history.jsonl")
	})

	it("buildDeployArgs disables churnHistoryOut when set to off", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
			churn: {
				diagnosticsDefault: "off" as const,
				topN: 5,
				groupRules: [],
			},
		}

		const args = __test__.buildDeployArgs(cfg, {
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			churnHistoryOut: "off",
		})

		expect(args.churnHistoryOut).toBeUndefined()
	})

	it("buildDeployArgs rejects invalid churnDiagnostics override", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
		}

		expect(() =>
			__test__.buildDeployArgs(cfg, {
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: false,
				churnDiagnostics: "invalid-mode",
			}),
		).toThrowError(
			expect.objectContaining({
				cause: "CONFIG_PROFILE_INVALID",
			}),
		)
	})

	it("buildDeployArgs rejects invalid churnTopN override", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const cfg = {
			name: "p",
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
		}

		expect(() =>
			__test__.buildDeployArgs(cfg, {
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: false,
				churnTopN: "0",
			}),
		).toThrowError(
			expect.objectContaining({
				cause: "CONFIG_PROFILE_INVALID",
			}),
		)
	})

	it("runPm2Phase treats PM2_APP_NAME_NOT_FOUND as fatal", async () => {
		const fatalError = Object.assign(new Error("missing"), {
			cause: "PM2_APP_NAME_NOT_FOUND",
		})
		const { logFns } = setupMocks({
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			updatePm2AppImpl: () => Promise.reject(fatalError),
		})
		const { __test__ } = await importMain()
		await expect(
			__test__.runPm2Phase({
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: false,
				profileName: "p",
			}),
		).rejects.toBe(fatalError)

		expect(logFns.logFatalError).toHaveBeenCalledWith(
			"PM2 update",
			fatalError,
			{ profileName: "p" },
		)
	})

	it("runPm2Phase logs non-fatal PM2 errors and continues", async () => {
		const err = Object.assign(new Error("health"), {
			cause: "PM2_HEALTHCHECK_FAILED",
		})
		const { logFns } = setupMocks({
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			updatePm2AppImpl: () => Promise.reject(err),
		})
		const { __test__ } = await importMain()
		await __test__.runPm2Phase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(logFns.logNonFatalError).toHaveBeenCalledWith(
			"PM2 update",
			err,
			{
				profileName: "p",
			},
		)
	})

	it("main sets exitCode 0 on success", async () => {
		process.exitCode = undefined
		const { logFns } = setupMocks({
			listProfilesReturn: ["test"],
			resolveProfileImpl: () => ({
				name: "test",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
			}),
		})
		const { __test__ } = await importMain()
		await __test__.main()

		expect(process.exitCode).toBe(0)
		expect(logFns.logUnexpectedError).not.toHaveBeenCalled()
	})

	it("main logs unexpected error and sets exitCode 1", async () => {
		const err = new Error("boom")
		process.exitCode = undefined
		const { logFns } = setupMocks({
			gunshiCliImpl: () => Promise.reject(err),
		})
		const { __test__ } = await importMain()

		await __test__.main()
		expect(process.exitCode).toBe(1)
		expect(logFns.logUnexpectedError).toHaveBeenCalled()
	})

	it("main does not double-log fatal errors that were already handled", async () => {
		process.exitCode = undefined
		const fatalError = new Error("fatal")
		let handledFatalError: Error | undefined
		const { logFns } = setupMocks({
			gunshiCliImpl: () => Promise.reject(handledFatalError),
		})
		const imported = await importMain()
		try {
			imported.__test__.handleFatalError("Tests", fatalError, "p")
		} catch (err) {
			handledFatalError = err as Error
		}

		await imported.__test__.main()

		expect(process.exitCode).toBe(1)
		expect(logFns.logUnexpectedError).not.toHaveBeenCalled()
	})

	it("deployCommand.run calls churn-only path when churnOnly is true", async () => {
		const computeMock = vi.fn().mockResolvedValue(buildReportFixture())
		const runBuildMock = vi.fn()
		const syncMock = vi.fn()
		const pm2Mock = vi.fn()
		const { logFns } = setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			computeClientChurnReportImpl: computeMock,
			runBuildImpl: runBuildMock,
			syncBuildImpl: syncMock,
			updatePm2AppImpl: pm2Mock,
		})
		const { __test__ } = await importMain()

		await (__test__.deployCommand as any).run({
			values: {
				profile: "p",
				churnOnly: true,
				dryRun: false,
				skipBuild: false,
				verbose: false,
			},
		} as any)

		expect(computeMock).toHaveBeenCalled()
		expect(runBuildMock).not.toHaveBeenCalled()
		expect(syncMock).not.toHaveBeenCalled()
		expect(pm2Mock).not.toHaveBeenCalled()
		expect(logFns.logChurnOnlyStart).toHaveBeenCalledWith({
			profileName: "p",
		})
		expect(logFns.logChurnOnlySuccess).toHaveBeenCalledWith({
			profileName: "p",
		})
	})

	it("deployCommand.run executes phases in order for full deploy", async () => {
		const phaseOrder: string[] = []
		const { publishDeployEvent } = setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			runTestsImpl: () => {
				phaseOrder.push("tests")
				return Promise.resolve()
			},
			runBuildImpl: () => {
				phaseOrder.push("build")
				return Promise.resolve()
			},
			syncBuildImpl: () => {
				phaseOrder.push("sync")
				return Promise.resolve()
			},
			updatePm2AppImpl: () => {
				phaseOrder.push("pm2")
				return Promise.resolve({ instanceCount: 1 })
			},
			computeClientChurnReportImpl: () => {
				phaseOrder.push("churn")
				return Promise.resolve(buildReportFixture())
			},
		})
		const { __test__ } = await importMain()

		await (__test__.deployCommand as any).run({
			values: {
				profile: "p",
				churnOnly: false,
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
			},
		} as any)

		expect(phaseOrder).toEqual(["tests", "build", "sync", "pm2", "churn"])
		expect(publishDeployEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "deploy.completed",
				gitSha: "abc1234",
				profileName: "p",
				releaseVersion: "v1.2.3",
				status: "completed",
			}),
			expect.anything(),
		)
	})

	it("deployCommand.run emits deploy.degraded when a non-fatal phase fails", async () => {
		const { publishDeployEvent } = setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			updatePm2AppImpl: () => Promise.reject(new Error("pm2 degraded")),
		})
		const { __test__ } = await importMain()

		await (__test__.deployCommand as any).run({
			values: {
				profile: "p",
				churnOnly: false,
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
			},
		} as any)

		expect(publishDeployEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "deploy.degraded",
				gitSha: "abc1234",
				profileName: "p",
				releaseVersion: "v1.2.3",
				status: "degraded",
			}),
			expect.anything(),
		)
	})

	it("deployCommand.run emits deploy.failed when a fatal phase fails", async () => {
		const { publishDeployEvent } = setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				events: {
					gitSha: "abc1234",
					releaseVersion: "v1.2.3",
					sinks: [],
				},
			}),
			runBuildImpl: () => Promise.reject(new Error("build boom")),
		})
		const { __test__ } = await importMain()

		await expect(
			(__test__.deployCommand as any).run({
				values: {
					profile: "p",
					churnOnly: false,
					dryRun: false,
					skipTests: false,
					skipBuild: false,
					verbose: false,
				},
			} as any),
		).rejects.toBeInstanceOf(Error)

		expect(publishDeployEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "deploy.failed",
				gitSha: "abc1234",
				profileName: "p",
				releaseVersion: "v1.2.3",
				status: "failed",
			}),
			expect.anything(),
		)
	})

	it("deployCommand.run treats log file setup failure as fatal configuration error", async () => {
		const { logFns } = setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
				logging: {
					console: {
						verboseDefault: false,
					},
					file: {
						enabled: true,
						dir: "package.json",
						mode: "append" as const,
					},
				},
			}),
		})
		const { __test__ } = await importMain()

		await expect(
			(__test__.deployCommand as any).run({
				values: {
					profile: "p",
					churnOnly: false,
					dryRun: false,
					skipTests: false,
					skipBuild: false,
					verbose: false,
				},
			} as any),
		).rejects.toBeInstanceOf(Error)

		expect(logFns.logFatalError).toHaveBeenCalledWith(
			"Configuration",
			expect.any(Error),
			{ profileName: "p" },
		)
	})

	it("runTestPhase skips when skipTests is true", async () => {
		const { logFns, runTests } = setupMocks({
			runTestsImpl: () => Promise.resolve(),
		})
		const { __test__ } = await importMain()

		await __test__.runTestPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: true,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(runTests).not.toHaveBeenCalled()
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			"Test suite skipped (per --skipTests / -T).",
		)
	})

	it("runTestPhase treats test failures as fatal", async () => {
		const testError = new Error("tests failed")
		const { logFns, runTests } = setupMocks({
			runTestsImpl: () => Promise.reject(testError),
		})
		const { __test__ } = await importMain()

		await expect(
			__test__.runTestPhase({
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: false,
				profileName: "p",
			}),
		).rejects.toBe(testError)

		expect(logFns.logFatalError).toHaveBeenCalledWith("Tests", testError, {
			profileName: "p",
		})
		expect(runTests).toHaveBeenCalledWith(
			expect.objectContaining({
				testBin: "npx",
				testArgs: ["vitest", "run", "--reporter=verbose"],
			}),
		)
	})

	it("runTestPhase writes failed test output to the file log without replaying it to the quiet terminal", async () => {
		const { runTests } = setupMocks({
			runTestsImpl: ({ onStdoutChunk, onStderrChunk }: any) => {
				onStdoutChunk?.("stdout chunk\n")
				onStderrChunk?.("stderr chunk\n")
				return Promise.reject(new Error("tests failed"))
			},
		})
		const { __test__ } = await importMain()
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockReturnValue(true as any)
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true as any)
		const fileChunks: string[] = []

		await expect(
			__test__.runTestPhase(
				{
					sshConnectionString: "s",
					remoteDir: "/r",
					buildDir: "/b",
					buildCommand: "npx",
					buildArgs: ["nuxt", "build"],
					env: "prod",
					pm2AppName: "app",
					pm2RestartMode: "startOrReload",
					dryRun: false,
					skipTests: false,
					skipBuild: false,
					verbose: false,
					churnOnly: false,
					profileName: "p",
				},
				{
					path: "/tmp/test.log",
					writeLine: () => {},
					writeChunk: (chunk) => fileChunks.push(chunk),
					writeEvent: () => {},
					close: () => Promise.resolve(),
				},
			),
		).rejects.toBeInstanceOf(Error)

		expect(runTests).toHaveBeenCalledWith(
			expect.objectContaining({
				testBin: "npx",
				testArgs: expect.arrayContaining([
					"vitest",
					"run",
					"--reporter=verbose",
					"--reporter=json",
				]),
				onStdoutChunk: expect.any(Function),
				onStderrChunk: expect.any(Function),
			}),
		)
		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
		expect(fileChunks).toEqual(["stdout chunk\n", "stderr chunk\n"])
	})

	it("runTestPhase uses inherit output mode in verbose mode", async () => {
		const { runTests } = setupMocks({
			runTestsImpl: () => Promise.resolve(),
		})
		const { __test__ } = await importMain()

		await __test__.runTestPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})

		expect(runTests).toHaveBeenCalledWith(
			expect.objectContaining({
				outputMode: "inherit",
				testBin: "npx",
				testArgs: ["vitest", "run", "--reporter=verbose"],
			}),
		)
	})

	it("createTestPhaseOutputHandlers uses inherit mode in verbose mode", async () => {
		setupMocks()
		const { __test__ } = await importMain()
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockReturnValue(true as any)
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockReturnValue(true as any)
		const handlers = __test__.createTestPhaseOutputHandlers(
			{
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: true,
				churnOnly: false,
				profileName: "p",
			},
			{
				path: "/tmp/test.log",
				writeLine: () => {},
				writeChunk: () => {},
				writeEvent: () => {},
				close: () => Promise.resolve(),
			},
		)

		expect(handlers.outputMode).toBe("inherit")
		expect(handlers.onStdoutChunk).toBeUndefined()
		expect(handlers.onStderrChunk).toBeUndefined()
		expect(stdoutSpy).not.toHaveBeenCalled()
		expect(stderrSpy).not.toHaveBeenCalled()
	})

	it("runBuildPhase skips build when skipBuild is true", async () => {
		const { logFns } = setupMocks({
			runBuildImpl: () => {
				throw new Error("should not run")
			},
		})
		const { __test__ } = await importMain()

		await __test__.runBuildPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: true,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(logFns.logPhaseStart).toHaveBeenCalledWith("Running build")
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			"Build skipped (per --skipBuild / -k).",
		)
	})

	it("runBuildPhase passes profile-defined command and args to runBuild", async () => {
		const runBuildMock = vi.fn().mockResolvedValue(undefined)
		setupMocks({
			runBuildImpl: runBuildMock,
		})
		const { __test__ } = await importMain()

		await __test__.runBuildPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "custom-cmd",
			buildArgs: ["arg1", "arg2"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(runBuildMock).toHaveBeenCalledWith(
			{ command: "custom-cmd", args: ["arg1", "arg2"] },
			expect.objectContaining({ outputMode: "silent" }),
		)
	})

	it("runBuildPhase uses inherit output mode in verbose mode", async () => {
		const runBuildMock = vi.fn().mockResolvedValue(undefined)
		setupMocks({ runBuildImpl: runBuildMock })
		const { __test__ } = await importMain()

		await __test__.runBuildPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "custom-cmd",
			buildArgs: ["arg1"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})

		expect(runBuildMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ outputMode: "inherit" }),
		)
	})

	it("runSyncPhase passes through dryRun flag", async () => {
		const syncMock = vi.fn().mockResolvedValue(undefined)
		setupMocks({
			syncBuildImpl: syncMock,
		})
		const { __test__ } = await importMain()

		await __test__.runSyncPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: true,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(syncMock).toHaveBeenCalledWith(
			expect.objectContaining({ dryRun: true }),
		)
	})

	it("runSyncPhase uses inherit output mode in verbose mode", async () => {
		const syncMock = vi.fn().mockResolvedValue(undefined)
		setupMocks({ syncBuildImpl: syncMock })
		const { __test__ } = await importMain()

		await __test__.runSyncPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})

		expect(syncMock).toHaveBeenCalledWith(
			expect.objectContaining({ outputMode: "inherit" }),
		)
	})

	it("runPm2Phase skips update when dryRun is true", async () => {
		const updateMock = vi.fn().mockResolvedValue({ instanceCount: 0 })
		const { logFns } = setupMocks({
			updatePm2AppImpl: updateMock,
		})
		const { __test__ } = await importMain()

		await __test__.runPm2Phase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: true,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(updateMock).not.toHaveBeenCalled()
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			"PM2 update complete: skipped.",
		)
	})

	it("runPm2Phase uses inherit output mode in verbose mode", async () => {
		const updateMock = vi.fn().mockResolvedValue({ instanceCount: 1 })
		setupMocks({ updatePm2AppImpl: updateMock })
		const { __test__ } = await importMain()

		await __test__.runPm2Phase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})

		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ outputMode: "inherit" }),
		)
	})

	it("runChurnPhase logs non-fatal errors while full deploy continues", async () => {
		const churnError = Object.assign(new Error("churn oops"), {
			cause: "CHURN_ERR",
		})
		const computeMock = vi.fn().mockRejectedValue(churnError)
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
		})

		expect(logFns.logNonFatalError).toHaveBeenCalledWith(
			"Client churn",
			churnError,
			{ profileName: "p" },
		)
	})

	it("runChurnPhase uses report computation by default", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const formatDiagnosticsMock = vi.fn().mockReturnValue("diag-output")
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
			formatChurnReportDiagnosticsImpl: formatDiagnosticsMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
			churnDiagnostics: "off",
		})

		expect(computeReportMock).toHaveBeenCalledWith({
			buildDir: "/b",
			sshConnectionString: "s",
			remoteDir: "/r",
			dryRun: false,
			profileName: "p",
			runMode: "deploy",
			groupRules: [],
		})
		expect(formatDiagnosticsMock).not.toHaveBeenCalled()
		expect(logFns.logChurnSummary).toHaveBeenCalledWith(
			{
				totalOldFiles: 10,
				totalNewFiles: 12,
				stableFiles: 5,
				changedFiles: 2,
				addedFiles: 3,
				removedFiles: 1,
				totalOldBytes: 1000,
				totalNewBytes: 1500,
				stableBytes: 500,
				changedBytes: 300,
				addedBytes: 700,
				removedBytes: 200,
				downloadImpactFilesPercent: 41.7,
				cacheReuseFilesPercent: 58.3,
				downloadImpactBytesPercent: 66.7,
				cacheReuseBytesPercent: 33.3,
			},
			{ dryRun: false },
		)
	})

	it("runChurnPhase forwards configured churnGroupRules", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
			churnDiagnostics: "off",
			churnGroupRules: [
				{ pattern: "components/**", group: "ui" },
				{ pattern: "vendor", group: "third-party" },
			],
		})

		expect(computeReportMock).toHaveBeenCalledWith({
			buildDir: "/b",
			sshConnectionString: "s",
			remoteDir: "/r",
			dryRun: false,
			profileName: "p",
			runMode: "deploy",
			groupRules: [
				{ pattern: "components/**", group: "ui" },
				{ pattern: "vendor", group: "third-party" },
			],
		})
		expect(logFns.logPhaseStart).toHaveBeenCalledWith(
			"Computing client churn metrics",
		)
	})

	it("runChurnOnlyMode treats churn errors as fatal", async () => {
		const churnError = new Error("boom")
		const computeMock = vi.fn().mockRejectedValue(churnError)
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeMock,
		})
		const { __test__ } = await importMain()
		await expect(
			__test__.runChurnOnlyMode({
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				buildCommand: "npx",
				buildArgs: ["nuxt", "build"],
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload",
				dryRun: false,
				skipTests: false,
				skipBuild: false,
				verbose: false,
				churnOnly: true,
				profileName: "p",
			}),
		).rejects.toBe(churnError)

		expect(logFns.logFatalError).toHaveBeenCalledWith(
			"Client churn",
			churnError,
			{ profileName: "p" },
		)
	})

	it("runChurnPhase uses report path and diagnostics formatter when enabled", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const formatDiagnosticsMock = vi.fn().mockReturnValue("diag-output")
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
			formatChurnReportDiagnosticsImpl: formatDiagnosticsMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
			churnDiagnostics: "full",
			churnTopN: 2,
		})

		expect(computeReportMock).toHaveBeenCalledWith({
			buildDir: "/b",
			sshConnectionString: "s",
			remoteDir: "/r",
			dryRun: false,
			profileName: "p",
			runMode: "deploy",
			groupRules: [],
		})
		expect(formatDiagnosticsMock).toHaveBeenCalledWith(
			expect.objectContaining({ schema: "com.dodefey.churn-report" }),
			{ mode: "full", topN: 2 },
		)
		expect(logFns.logChurnSummary).toHaveBeenCalledWith(
			{
				totalOldFiles: 10,
				totalNewFiles: 12,
				stableFiles: 5,
				changedFiles: 2,
				addedFiles: 3,
				removedFiles: 1,
				totalOldBytes: 1000,
				totalNewBytes: 1500,
				stableBytes: 500,
				changedBytes: 300,
				addedBytes: 700,
				removedBytes: 200,
				downloadImpactFilesPercent: 41.7,
				cacheReuseFilesPercent: 58.3,
				downloadImpactBytesPercent: 66.7,
				cacheReuseBytesPercent: 33.3,
			},
			{ dryRun: false },
		)
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith("diag-output")
	})

	it("runChurnPhase uses report path when churnReportOut is set", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const formatDiagnosticsMock = vi.fn().mockReturnValue("diag-output")
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
			formatChurnReportDiagnosticsImpl: formatDiagnosticsMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
			churnDiagnostics: "off",
			churnReportOut: "stdout",
		})

		expect(computeReportMock).toHaveBeenCalledWith({
			buildDir: "/b",
			sshConnectionString: "s",
			remoteDir: "/r",
			dryRun: false,
			profileName: "p",
			runMode: "deploy",
			groupRules: [],
		})
		expect(formatDiagnosticsMock).not.toHaveBeenCalled()
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			expect.stringContaining('"schema": "com.dodefey.churn-report"'),
		)
	})

	it("runChurnOnlyMode writes report JSON to stdout when requested", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const formatDiagnosticsMock = vi.fn().mockReturnValue("diag-output")
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
			formatChurnReportDiagnosticsImpl: formatDiagnosticsMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnOnlyMode({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: true,
			profileName: "p",
			churnDiagnostics: "off",
			churnReportOut: "stdout",
		})

		expect(computeReportMock).toHaveBeenCalledWith({
			buildDir: "/b",
			sshConnectionString: "s",
			remoteDir: "/r",
			dryRun: false,
			profileName: "p",
			runMode: "churnOnly",
			groupRules: [],
		})
		expect(formatDiagnosticsMock).not.toHaveBeenCalled()
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			expect.stringContaining('"schema": "com.dodefey.churn-report"'),
		)
	})

	it("runChurnPhase writes churn history record to stdout when requested", async () => {
		const computeReportMock = vi
			.fn()
			.mockResolvedValue(buildReportFixture())
		const { logFns } = setupMocks({
			computeClientChurnReportImpl: computeReportMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			buildCommand: "npx",
			buildArgs: ["nuxt", "build"],
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: false,
			profileName: "p",
			churnDiagnostics: "off",
			churnHistoryOut: "stdout",
		})

		expect(computeReportMock).toHaveBeenCalled()
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			expect.stringContaining(
				'"schema":"com.dodefey.churn-history-record"',
			),
		)
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			expect.stringContaining(
				'"report":{"schema":"com.dodefey.churn-report"',
			),
		)
	})
})
