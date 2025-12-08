import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TChurnMetrics } from "./../src/churn"
import * as churnFormatModule from "./../src/churnFormat"
import type { TLoggerSink } from "./../src/deployLogging"
import {
	extractErrorCode,
	formatFatalError,
	formatNonFatalError,
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
} from "./../src/deployLogging"

describe("deployLogging utilities", () => {
	describe("extractErrorCode", () => {
		it("returns code when cause is a string", () => {
			const err = Object.assign(new Error("msg"), {
				cause: "BUILD_FAILED",
			})
			expect(extractErrorCode(err)).toBe("BUILD_FAILED")
		})

		it("returns undefined for non-string cause", () => {
			const err = Object.assign(new Error("msg"), { cause: 123 })
			expect(extractErrorCode(err)).toBeUndefined()
		})

		it("returns undefined for non-Error inputs", () => {
			expect(extractErrorCode("oops")).toBeUndefined()
			expect(extractErrorCode({})).toBeUndefined()
			expect(extractErrorCode(null)).toBeUndefined()
			expect(extractErrorCode(undefined)).toBeUndefined()
		})
	})

	describe("toErrorMessage", () => {
		it("returns message for Error", () => {
			expect(toErrorMessage(new Error("boom"))).toBe("boom")
		})

		it("stringifies non-Error values", () => {
			expect(toErrorMessage("oops")).toBe("oops")
			expect(toErrorMessage(42 as any)).toBe("42")
			expect(toErrorMessage(null as any)).toBe("null")
			expect(toErrorMessage(undefined as any)).toBe("undefined")
		})
	})

	describe("formatFatalError", () => {
		it("code + profile", () => {
			expect(
				formatFatalError("Build", "BUILD_FAILED", "msg", "prod"),
			).toBe('Build error [BUILD_FAILED] (profile="prod"): msg')
		})
		it("code only", () => {
			expect(formatFatalError("Build", "BUILD_FAILED", "msg")).toBe(
				"Build error [BUILD_FAILED]: msg",
			)
		})
		it("profile only", () => {
			expect(formatFatalError("Build", undefined, "msg", "prod")).toBe(
				'Build error (profile="prod"): msg',
			)
		})
		it("neither", () => {
			expect(formatFatalError("Build", undefined, "msg")).toBe(
				"Build error: msg",
			)
		})
	})

	describe("formatNonFatalError", () => {
		it("code + profile", () => {
			expect(
				formatNonFatalError("Build", "BUILD_FAILED", "msg", "prod"),
			).toBe(
				'Deploy succeeded, but Build step failed [BUILD_FAILED] (profile="prod"): msg',
			)
		})
		it("code only", () => {
			expect(formatNonFatalError("Build", "BUILD_FAILED", "msg")).toBe(
				"Deploy succeeded, but Build step failed [BUILD_FAILED]: msg",
			)
		})
		it("profile only", () => {
			expect(formatNonFatalError("Build", undefined, "msg", "prod")).toBe(
				'Deploy succeeded, but Build step failed (profile="prod"): msg',
			)
		})
		it("neither", () => {
			expect(formatNonFatalError("Build", undefined, "msg")).toBe(
				"Deploy succeeded, but Build step failed: msg",
			)
		})
	})
})

describe("deployLogging sink and wiring", () => {
	let infoLines: string[]
	let errorLines: string[]
	let testSink: TLoggerSink

	beforeEach(() => {
		infoLines = []
		errorLines = []
		testSink = {
			info: (line) => infoLines.push(line),
			error: (line) => errorLines.push(line),
		}
		setLoggerSink(testSink)
	})

	afterEach(() => {
		setLoggerSink(null)
	})

	it("setLoggerSink swaps to custom sink", () => {
		logDeployStart({})
		expect(infoLines).toEqual(["[deploy] Starting deploy..."])
		expect(errorLines).toEqual([])
	})

	describe("lifecycle logs", () => {
		it("logDeployStart with/without profile", () => {
			logDeployStart({ profileName: "prod" })
			logDeployStart({})
			expect(infoLines).toEqual([
				'[deploy] Starting deploy for profile "prod"...',
				"[deploy] Starting deploy...",
			])
			expect(errorLines).toEqual([])
		})

		it("logDeploySuccess with/without profile", () => {
			logDeploySuccess({ profileName: "prod" })
			logDeploySuccess({})
			expect(infoLines).toEqual([
				'[deploy] Deploy completed successfully for profile "prod".',
				"[deploy] Deploy completed successfully.",
			])
		})

		it("logChurnOnlyStart/Success with/without profile", () => {
			logChurnOnlyStart({ profileName: "prod" })
			logChurnOnlyStart({})
			logChurnOnlySuccess({ profileName: "prod" })
			logChurnOnlySuccess({})
			expect(infoLines).toEqual([
				'[deploy] Starting churn-only run for profile "prod"...',
				"[deploy] Starting churn-only run...",
				'[deploy] Churn-only run completed successfully for profile "prod".',
				"[deploy] Churn-only run completed successfully.",
			])
			expect(errorLines).toEqual([])
		})
	})

	describe("phase logs", () => {
		it("logPhaseStart/Success", () => {
			logPhaseStart("Running Nuxt build")
			logPhaseSuccess("Nuxt build completed successfully.")
			expect(infoLines).toEqual([
				"[deploy] Running Nuxt build...",
				"[deploy] Nuxt build completed successfully.",
			])
			expect(errorLines).toEqual([])
		})
	})

	describe("pm2 success log", () => {
		it("logPm2Success", () => {
			logPm2Success({
				appName: "TestApp",
				restartMode: "startOrReload",
				instanceCount: 2,
				profileName: "prod",
			})
			expect(infoLines).toEqual([
				'[deploy] PM2 update complete for "TestApp": 2 instances online (mode: startOrReload).',
			])
			expect(errorLines).toEqual([])
		})
	})

	describe("churn summary log", () => {
		it("logChurnSummary uses formatChurnMetrics output", () => {
			const spy = vi.spyOn(churnFormatModule, "formatChurnMetrics")
			spy.mockReturnValue("LINE1\nLINE2\nLINE3")

			const metrics: TChurnMetrics = {
				totalOldFiles: 0,
				totalNewFiles: 1,
				stableFiles: 0,
				changedFiles: 0,
				addedFiles: 1,
				removedFiles: 0,
				totalOldBytes: 0,
				totalNewBytes: 100,
				stableBytes: 0,
				changedBytes: 0,
				addedBytes: 100,
				removedBytes: 0,
				downloadImpactFilesPercent: 100,
				cacheReuseFilesPercent: 0,
				downloadImpactBytesPercent: 100,
				cacheReuseBytesPercent: 0,
			}

			logChurnSummary(metrics, { dryRun: true })
			expect(infoLines).toEqual(["LINE1\nLINE2\nLINE3"])
			expect(errorLines).toEqual([])
			spy.mockRestore()
		})
	})

	describe("error logs", () => {
		it("logFatalError formats code + profile", () => {
			const err = Object.assign(new Error("boom"), {
				cause: "BUILD_FAILED",
			})
			logFatalError("Build", err, { profileName: "prod" })
			expect(errorLines).toEqual([
				'Build error [BUILD_FAILED] (profile="prod"): boom',
			])
			expect(infoLines).toEqual([])
		})

		it("logFatalError without code", () => {
			const err = new Error("boom")
			logFatalError("Build", err, { profileName: "prod" })
			expect(errorLines).toEqual(['Build error (profile="prod"): boom'])
		})

		it("logNonFatalError formats code + profile", () => {
			const err = Object.assign(new Error("oops"), {
				cause: "BUILD_FAILED",
			})
			logNonFatalError("Build", err, { profileName: "prod" })
			expect(errorLines).toEqual([
				'Deploy succeeded, but Build step failed [BUILD_FAILED] (profile="prod"): oops',
			])
			expect(infoLines).toEqual([])
		})

		it("logUnexpectedError with code + profile", () => {
			const err = Object.assign(new Error("whoa"), { cause: "OOPS" })
			logUnexpectedError(err, { profileName: "prod" })
			expect(errorLines).toEqual([
				'[deploy] Unexpected deploy error [OOPS] (profile="prod"): whoa',
			])
			expect(infoLines).toEqual([])
		})

		it("logUnexpectedError without code", () => {
			const err = new Error("whoa")
			logUnexpectedError(err, { profileName: "prod" })
			expect(errorLines).toEqual([
				'[deploy] Unexpected deploy error (profile="prod"): whoa',
			])
			expect(infoLines).toEqual([])
		})

		it("logUnexpectedError with non-Error input", () => {
			logUnexpectedError("bad news")
			expect(errorLines).toEqual([
				"[deploy] Unexpected deploy error: bad news",
			])
			expect(infoLines).toEqual([])
		})
	})
})
