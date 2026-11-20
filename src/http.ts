import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
export function httpHandler(
  app: (request: Request) => Promise<Response>,
  rewrite = false,
) {
  return async (
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
  ) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (rewrite) {
        const route = url.searchParams.get("route");
        if (route?.startsWith("/v1/")) url.pathname = route;
        url.searchParams.delete("route");
        // Vercel's :path* rewrite capture is transport metadata, not an API filter.
        url.searchParams.delete("path");
      }
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.body !== undefined)
          init.body = Buffer.isBuffer(req.body)
            ? new Uint8Array(req.body)
            : typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body);
        else {
          init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
      }
      const response = await app(new Request(url, init));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: { code: "internal_error", message: "Request failed." },
        }),
      );
    }
  };
}
