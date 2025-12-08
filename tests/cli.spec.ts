import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type MockConfig = {
	listProfilesReturn?: string[]
	resolveProfileImpl?: () => any
	updatePm2AppImpl?: () => any
	runNuxtBuildImpl?: () => any
	runTestsImpl?: () => any
	syncBuildImpl?: () => any
	computeClientChurnImpl?: () => any
	gunshiCliImpl?: () => any
}

function setupMocks(config: MockConfig = {}) {
	const logFns = {
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
	vi.doMock("./../src/build.ts", () => ({
		runNuxtBuild: vi
			.fn()
			.mockImplementation(
				config.runNuxtBuildImpl ?? (() => Promise.resolve()),
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
		computeClientChurn: vi
			.fn()
			.mockImplementation(
				config.computeClientChurnImpl ??
					(() => Promise.resolve("metrics")),
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

	return { logFns, listProfiles, resolveProfile, runTests }
}

async function importMain() {
	return await import("../src/cli")
}

describe("main.ts wiring", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.restoreAllMocks()
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
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
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
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload" as const,
		}
		const overrides = {
			sshConnectionString: " s2 ",
			remoteDir: " /r2 ",
			buildDir: " /b2 ",
			env: " e2 ",
			pm2AppName: " app2 ",
			pm2RestartMode: "reboot",
			skipTests: false,
		}
		const merged = __test__.applyOverrides(cfg, overrides)
		expect(merged).toMatchObject({
			sshConnectionString: "s2",
			remoteDir: "/r2",
			buildDir: "/b2",
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
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: true,
			skipBuild: false,
			verbose: true,
			churnOnly: false,
			profileName: "p",
		})
	})

	it("runPm2Phase treats PM2_APP_NAME_NOT_FOUND as fatal", async () => {
		const fatalError = Object.assign(new Error("missing"), {
			cause: "PM2_APP_NAME_NOT_FOUND",
		})
		const { logFns } = setupMocks({
			resolveProfileImpl: () => ({}),
			updatePm2AppImpl: () => Promise.reject(fatalError),
		})
		const { __test__ } = await importMain()
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error allow returning undefined for tests
			() => undefined,
		)

		await __test__.runPm2Phase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
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

		expect(logFns.logFatalError).toHaveBeenCalledWith(
			"PM2 update",
			fatalError,
			{ profileName: "p" },
		)
		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it("runPm2Phase logs non-fatal PM2 errors and continues", async () => {
		const err = Object.assign(new Error("health"), {
			cause: "PM2_HEALTHCHECK_FAILED",
		})
		const { logFns } = setupMocks({
			resolveProfileImpl: () => ({}),
			updatePm2AppImpl: () => Promise.reject(err),
		})
		const { __test__ } = await importMain()
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error
			() => undefined,
		)

		await __test__.runPm2Phase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
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
		expect(exitSpy).not.toHaveBeenCalled()
	})

	it("main exits 0 on success", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error
			() => undefined,
		)
		const { logFns } = setupMocks({
			listProfilesReturn: ["test"],
			resolveProfileImpl: () => ({
				name: "test",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
			}),
		})
		const { __test__ } = await importMain()
		await __test__.main()

		expect(exitSpy).toHaveBeenCalledWith(0)
		expect(logFns.logUnexpectedError).not.toHaveBeenCalled()
	})

	it("main logs unexpected error and exits 1", async () => {
		const err = new Error("boom")
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error
			() => undefined,
		)
		const { logFns } = setupMocks({
			gunshiCliImpl: () => Promise.reject(err),
		})
		const { __test__ } = await importMain()

		await __test__.main()
		expect(exitSpy).toHaveBeenCalledWith(1)
		expect(logFns.logUnexpectedError).toHaveBeenCalled()
	})

	it("deployCommand.run calls churn-only path when churnOnly is true", async () => {
		const computeMock = vi.fn().mockResolvedValue("metrics")
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
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
			}),
			computeClientChurnImpl: computeMock,
			runNuxtBuildImpl: runBuildMock,
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
		setupMocks({
			listProfilesReturn: ["p"],
			resolveProfileImpl: () => ({
				name: "p",
				sshConnectionString: "s",
				remoteDir: "/r",
				buildDir: "/b",
				env: "prod",
				pm2AppName: "app",
				pm2RestartMode: "startOrReload" as const,
			}),
			runTestsImpl: () => {
				phaseOrder.push("tests")
				return Promise.resolve()
			},
			runNuxtBuildImpl: () => {
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
			computeClientChurnImpl: () => {
				phaseOrder.push("churn")
				return Promise.resolve("metrics")
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
		const { logFns } = setupMocks({
			runTestsImpl: () => Promise.reject(testError),
		})
		const { __test__ } = await importMain()
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error allow returning undefined for tests
			() => undefined,
		)

		await __test__.runTestPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
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

		expect(logFns.logFatalError).toHaveBeenCalledWith("Tests", testError, {
			profileName: "p",
		})
		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it("runBuildPhase skips Nuxt build when skipBuild is true", async () => {
		const { logFns } = setupMocks({
			runNuxtBuildImpl: () => {
				throw new Error("should not run")
			},
		})
		const { __test__ } = await importMain()

		await __test__.runBuildPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
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

		expect(logFns.logPhaseStart).toHaveBeenCalledWith("Running Nuxt build")
		expect(logFns.logPhaseSuccess).toHaveBeenCalledWith(
			"Nuxt build skipped (per --skipBuild / -k).",
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

	it("runChurnPhase logs non-fatal errors while full deploy continues", async () => {
		const churnError = Object.assign(new Error("churn oops"), {
			cause: "CHURN_ERR",
		})
		const computeMock = vi.fn().mockRejectedValue(churnError)
		const { logFns } = setupMocks({
			computeClientChurnImpl: computeMock,
		})
		const { __test__ } = await importMain()

		await __test__.runChurnPhase({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
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

	it("runChurnOnlyMode treats churn errors as fatal", async () => {
		const churnError = new Error("boom")
		const computeMock = vi.fn().mockRejectedValue(churnError)
		const { logFns } = setupMocks({
			computeClientChurnImpl: computeMock,
		})
		const { __test__ } = await importMain()
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(
			// @ts-expect-error
			() => undefined,
		)

		await __test__.runChurnOnlyMode({
			sshConnectionString: "s",
			remoteDir: "/r",
			buildDir: "/b",
			env: "prod",
			pm2AppName: "app",
			pm2RestartMode: "startOrReload",
			dryRun: false,
			skipTests: false,
			skipBuild: false,
			verbose: false,
			churnOnly: true,
			profileName: "p",
		})

		expect(logFns.logFatalError).toHaveBeenCalledWith(
			"Client churn",
			churnError,
			{ profileName: "p" },
		)
		expect(exitSpy).toHaveBeenCalledWith(1)
	})
})
