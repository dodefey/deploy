import type {
	TDeployEventType,
	TResolvedEventsConfig,
	TResolvedHttpWebhookEventSinkConfig,
} from "./config.js"

export interface TDeployEvent {
	type: TDeployEventType
	timestamp: string
	deployId: string
	profileName: string
	status: "completed" | "failed" | "degraded"
	message: string
	data?: Record<string, unknown>
}

export async function publishDeployEvent(
	event: TDeployEvent,
	config: TResolvedEventsConfig | undefined,
): Promise<void> {
	const sinks = config?.sinks ?? []
	for (const sink of sinks) {
		if (!sink.on.includes(event.type)) continue
		await publishToSink(event, sink)
	}
}

async function publishToSink(
	event: TDeployEvent,
	sink: TResolvedHttpWebhookEventSinkConfig,
): Promise<void> {
	try {
		await publishHttpWebhookEvent(event, sink)
	} catch (err) {
		if (sink.fatal) {
			throw err
		}
	}
}

async function publishHttpWebhookEvent(
	event: TDeployEvent,
	sink: TResolvedHttpWebhookEventSinkConfig,
): Promise<void> {
	let attempt = 0
	let lastError: unknown
	const totalAttempts = sink.retries + 1

	while (attempt < totalAttempts) {
		attempt += 1
		try {
			await postWebhookEvent(event, sink)
			return
		} catch (err) {
			lastError = err
			if (attempt >= totalAttempts) break
		}
	}

	throw createWebhookError(sink.url, lastError)
}

async function postWebhookEvent(
	event: TDeployEvent,
	sink: TResolvedHttpWebhookEventSinkConfig,
): Promise<void> {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort()
	}, sink.timeoutMs)

	try {
		const response = await fetch(sink.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...sink.headers,
			},
			body: JSON.stringify(event),
			signal: controller.signal,
		})

		if (!response.ok) {
			throw new Error(
				`Webhook responded with ${response.status} ${response.statusText}`.trim(),
			)
		}
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Webhook request timed out after ${sink.timeoutMs}ms`)
		}
		throw err
	} finally {
		clearTimeout(timeout)
	}
}

function createWebhookError(url: string, cause: unknown): Error {
	const err = new Error(
		`Deploy event webhook delivery failed for ${url}: ${toErrorMessage(cause)}`,
	)
	err.cause = cause
	return err
}

function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
