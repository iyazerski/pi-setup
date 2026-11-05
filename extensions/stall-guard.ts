import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Fail model requests that stall, so pi retries them instead of waiting up to 10 minutes.
 *
 * Model requests sometimes hang: no tokens, no thinking, for 2 to 10 minutes, then they either
 * finish or hit the client's timeout. Sessions showed it on about 1% of Anthropic requests, and on
 * OpenAI-compatible gateways such as LiteLLM too. Stopping and resending the message fixed it. pi's
 * HTTP idle timeout doesn't catch it: the server keeps the stream open, and its keepalives (`ping`
 * events, SSE comments) count as traffic.
 *
 * So this wraps `fetch` for requests to the base URL of any model in pi's registry, and fails a
 * request when nothing but keepalives arrives for STALL_MS, counting from the request start or the
 * last event. The error reads as a network error, which pi retries with backoff (settings
 * `retry.*`), the same as stopping and resending by hand. A real response streams events every few
 * seconds, even while the model thinks, so the limit stays far above them. Providers that stream
 * over WebSocket don't go through `fetch` and aren't covered.
 *
 * pi's provider clients read the global `fetch` each time they are created, once per request, so
 * the wrapper applies to every request after this extension loads.
 */

const STALL_MS = Number(process.env.PI_STREAM_STALL_MS ?? 120_000);
// Marks the wrapper, so reloading the extension doesn't wrap it twice.
const GUARD = Symbol.for("pi-setup.stall-guard");

type Fetch = typeof globalThis.fetch;

/** Return the URL of a fetch input. */
function inputUrl(input: Parameters<Fetch>[0]): URL {
	return new URL(input instanceof Request ? input.url : String(input));
}

/** Return whether a complete SSE event is a keepalive: comments only, a `ping` event, or a ping payload. */
export function isKeepalive(event: string): boolean {
	const lines = event.split(/\r?\n/).filter((line) => line !== "");
	const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
	const data = lines
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n");
	if (name === "ping") return true;
	if (!lines.some((line) => line.startsWith("data:"))) return lines.every((line) => line.startsWith(":"));
	return /^\{\s*"type"\s*:\s*"ping"\s*[,}]/.test(data);
}

/** Wrap `fetch` so matching requests fail once nothing but keepalives arrives for `stallMs`. */
export function createStallGuard(inner: Fetch, stallMs: number, matches: (url: URL) => boolean): Fetch {
	const guarded = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
		const url = inputUrl(input);
		if (!matches(url)) return inner(input, init);

		const controller = new AbortController();
		const outer = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		// A user abort passes through unchanged, so pi still reports it as aborted.
		const forwardAbort = (): void => controller.abort(outer?.reason);
		if (outer?.aborted) forwardAbort();
		else outer?.addEventListener("abort", forwardAbort, { once: true });

		let stalled: Error | undefined;
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let cancelSource: ((reason: unknown) => Promise<void>) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = (): void => {
			clearTimeout(timer);
			outer?.removeEventListener("abort", forwardAbort);
		};
		const stall = (): void => {
			// "network error" is in pi's retryable error patterns.
			stalled = new Error(
				`network error: ${url.host} sent no stream events for ${Math.round(stallMs / 1000)}s, so the request stalled`,
			);
			stop();
			streamController?.error(stalled);
			cancelSource?.(stalled).catch(() => {});
			controller.abort(stalled);
		};
		const arm = (): void => {
			clearTimeout(timer);
			timer = setTimeout(stall, stallMs);
		};

		arm();
		let response: Response;
		try {
			response = await inner(input, { ...init, signal: controller.signal });
		} catch (error) {
			stop();
			throw stalled ?? error;
		}
		if (!response.ok || !response.body) {
			stop();
			return response;
		}

		// For SSE, only events other than keepalives count as progress. For other bodies, any bytes do.
		const sse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
		const source = response.body.getReader();
		cancelSource = (reason) => source.cancel(reason);
		const decoder = new TextDecoder();
		// Text after the last complete event, since an event can span chunks.
		let pending = "";
		const body = new ReadableStream<Uint8Array>({
			start(controllerOfBody) {
				streamController = controllerOfBody;
			},
			async pull(controllerOfBody) {
				try {
					const { done, value } = await source.read();
					if (stalled) return;
					if (done) {
						stop();
						controllerOfBody.close();
						return;
					}
					if (!sse) arm();
					else {
						const events = (pending + decoder.decode(value, { stream: true })).split(/\r?\n\r?\n/);
						pending = events.pop() ?? "";
						if (events.some((event) => !isKeepalive(event))) arm();
					}
					controllerOfBody.enqueue(value);
				} catch (error) {
					if (stalled) return;
					stop();
					controllerOfBody.error(error);
				}
			},
			cancel(reason) {
				stop();
				return source.cancel(reason);
			},
		});
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
	// Keep the properties of the inner fetch, such as Bun's `fetch.preconnect`.
	return Object.assign(guarded, inner, { [GUARD]: true });
}

export default function (pi: ExtensionAPI) {
	if (!(STALL_MS > 0) || (globalThis.fetch as Fetch & { [GUARD]?: boolean })[GUARD]) return;

	// Base URLs of the models in the registry, without a trailing slash.
	let baseUrls = new Set<string>();
	const refresh = (ctx: ExtensionContext): void => {
		const urls = ctx.modelRegistry.getAll().map((model) => model.baseUrl);
		baseUrls = new Set(urls.filter((url) => /^https?:\/\//.test(url)).map((url) => url.replace(/\/+$/, "")));
	};
	// Providers can register while pi runs, so refresh before every request too.
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("before_provider_request", (_event, ctx) => refresh(ctx));

	const matches = (url: URL): boolean => {
		const href = url.href;
		for (const base of baseUrls) if (href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}?`)) return true;
		return false;
	};
	globalThis.fetch = createStallGuard(globalThis.fetch, STALL_MS, matches);
}
