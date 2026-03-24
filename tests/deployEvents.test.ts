import { afterEach, describe, expect, it, vi } from "vitest"
import { publishDeployEvent, type TDeployEvent } from "../src/deployEvents"
import type { TResolvedEventsConfig } from "../src/config"

const baseEvent: TDeployEvent = {
	type: "deploy.completed",
	timestamp: "2026-03-23T12:00:00.000Z",
	deployId: "deploy-1",
	gitSha: "abc1234",
	releaseVersion: "v1.2.3",
	profileName: "prod",
	status: "completed",
	message: "Deploy completed successfully.",
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("deploy events", () => {
	it("posts matching webhook events", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 202,
			statusText: "Accepted",
		})
		vi.stubGlobal("fetch", fetchMock)

		const config: TResolvedEventsConfig = {
			sinks: [
				{
					type: "http-webhook",
					url: "http://127.0.0.1:4000/hooks/deploy",
					on: ["deploy.completed"],
					timeoutMs: 3000,
					retries: 1,
					fatal: false,
					headers: {
						authorization: "Bearer token",
					},
				},
			],
		}

		await publishDeployEvent(baseEvent, config)

		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:4000/hooks/deploy",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"content-type": "application/json",
					authorization: "Bearer token",
				}),
				body: JSON.stringify(baseEvent),
			}),
		)
	})

	it("skips sinks that do not subscribe to the event type", async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)

		await publishDeployEvent(baseEvent, {
			sinks: [
				{
					type: "http-webhook",
					url: "http://127.0.0.1:4000/hooks/deploy",
					on: ["deploy.failed"],
					timeoutMs: 3000,
					retries: 1,
					fatal: false,
					headers: {},
				},
			],
		})

		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("retries failed webhook delivery before succeeding", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("socket hang up"))
			.mockResolvedValueOnce({
				ok: true,
				status: 202,
				statusText: "Accepted",
			})
		vi.stubGlobal("fetch", fetchMock)

		await publishDeployEvent(baseEvent, {
			sinks: [
				{
					type: "http-webhook",
					url: "http://127.0.0.1:4000/hooks/deploy",
					on: ["deploy.completed"],
					timeoutMs: 3000,
					retries: 1,
					fatal: false,
					headers: {},
				},
			],
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("swallows webhook failures when the sink is non-fatal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("connection refused")),
		)

		await expect(
			publishDeployEvent(baseEvent, {
				sinks: [
					{
						type: "http-webhook",
						url: "http://127.0.0.1:4000/hooks/deploy",
						on: ["deploy.completed"],
						timeoutMs: 3000,
						retries: 0,
						fatal: false,
						headers: {},
					},
				],
			}),
		).resolves.toBeUndefined()
	})

	it("throws webhook failures when the sink is fatal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("connection refused")),
		)

		await expect(
			publishDeployEvent(baseEvent, {
				sinks: [
					{
						type: "http-webhook",
						url: "http://127.0.0.1:4000/hooks/deploy",
						on: ["deploy.completed"],
						timeoutMs: 3000,
						retries: 0,
						fatal: true,
						headers: {},
					},
				],
			}),
		).rejects.toThrow(
			"Deploy event webhook delivery failed for http://127.0.0.1:4000/hooks/deploy",
		)
	})
})
