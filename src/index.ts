import { createMcpHandler } from "agents/mcp/server";
import { Effect } from "effect";
import { ConfigurationError, loadConfig, type Bindings } from "./config";
import { createServer } from "./mcp";

function jsonError(status: number, message: string) {
  return Response.json({ error: message }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
    },
  });
}

function validToken(header: string | null, expected: string) {
  const token = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (token === undefined) return false;
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(token);
  const expectedBytes = encoder.encode(expected);
  return actualBytes.byteLength === expectedBytes.byteLength &&
    crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return jsonError(404, "Not found.");
    try {
      const config = await Effect.runPromise(
        loadConfig(env).pipe(Effect.match({
          onFailure: (error) => error,
          onSuccess: (value) => value,
        })),
        { signal: request.signal },
      );
      if (config instanceof ConfigurationError) {
        return jsonError(503, `The service is not configured: ${config.fields.join(", ")}.`);
      }
      if (!validToken(request.headers.get("Authorization"), config.authToken)) {
        return jsonError(401, "Authentication required.");
      }
      const response = await createMcpHandler(() => createServer(config, request.signal), {
        route: "/mcp",
        corsOptions: false,
      })(request, env, ctx);
      const protectedResponse = new Response(response.body, response);
      protectedResponse.headers.set("Cache-Control", "no-store");
      return protectedResponse;
    } catch {
      return jsonError(500, "The request failed.");
    }
  },
} satisfies ExportedHandler<Bindings>;
