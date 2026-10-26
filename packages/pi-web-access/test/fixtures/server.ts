import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

/** A request the fixture received. */
export interface Recorded {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: unknown;
	/** Whether the client closed the connection before the response was complete. */
	closedEarly: boolean;
}

/** A scripted response: JSON, raw text, or server-sent events, optionally after a delay or never. */
export interface Reply {
	status?: number;
	headers?: Record<string, string>;
	json?: unknown;
	text?: string;
	/** Server-sent events: each object is sent as `event: <type>` plus its JSON data. */
	sse?: Record<string, unknown>[];
	delayMs?: number;
	/** Never answers; only the client closing the connection ends the request. */
	hang?: boolean;
}

export type Script = Reply | ((request: Recorded) => Reply);

export interface FixtureServer {
	/** `http://127.0.0.1:<port>`. */
	readonly url: string;
	readonly requests: Recorded[];
	/** Requests to `path`, in order. */
	at(path: string): Recorded[];
	/** Queues replies for `path`; each request takes the next one and the last one repeats. */
	route(path: string, ...replies: Script[]): void;
	close(): Promise<void>;
}

/** A local HTTP server that records every request and answers from per-path scripts (404 when none). */
export async function startServer(): Promise<FixtureServer> {
	const requests: Recorded[] = [];
	const routes = new Map<string, Script[]>();
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown = raw;
			try {
				body = raw === "" ? undefined : JSON.parse(raw);
			} catch {
				// Not JSON: the text is kept as the body.
			}
			const path = (req.url ?? "").split("?")[0] ?? "";
			const recorded: Recorded = { method: req.method ?? "", path, headers: req.headers, body, closedEarly: false };
			requests.push(recorded);
			res.on("close", () => {
				if (!res.writableEnded) recorded.closedEarly = true;
			});
			const queue = routes.get(path);
			const script = queue && queue.length > 1 ? queue.shift() : queue?.[0];
			if (!script) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `no fixture route for ${path}` } }));
				return;
			}
			const reply = typeof script === "function" ? script(recorded) : script;
			if (reply.hang) return;
			const send = (): void => {
				if (res.destroyed) return;
				if (reply.sse) {
					res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", ...reply.headers });
					for (const event of reply.sse) {
						const { type } = event;
						res.write(`event: ${String(type)}\ndata: ${JSON.stringify(event)}\n\n`);
					}
					res.end();
					return;
				}
				const isJson = reply.json !== undefined;
				res.writeHead(reply.status ?? 200, {
					"content-type": isJson ? "application/json" : "text/plain",
					...reply.headers,
				});
				res.end(isJson ? JSON.stringify(reply.json) : (reply.text ?? ""));
			};
			if (reply.delayMs) setTimeout(send, reply.delayMs);
			else send();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		at: (path) => requests.filter((request) => request.path === path),
		route: (path, ...replies) => {
			routes.set(path, replies);
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
