import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import worker from "../src/index";
import type { Bindings } from "../src/config";

const bindings: Bindings = {
  RIPE_ATLAS_API_KEY: "0123456789abcdef0123456789abcdef",
  MCP_AUTH_TOKEN: "test-mcp-token-with-at-least-32-characters",
};
const outgoing = vi.fn<typeof fetch>();
const rpcEnvelope = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

async function dispatch(request: Request, env: Bindings = bindings) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function request(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("https://ripe-atlas-mcp.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bindings.MCP_AUTH_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function readRpc(response: Response) {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const data = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : text;
  return rpcEnvelope.parse(JSON.parse(data ?? "null"));
}

async function call(name: string, args: Record<string, unknown> = {}, env: Bindings = bindings) {
  const response = await dispatch(request("tools/call", { name, arguments: args }), env);
  const rpc = await readRpc(response);
  expect(rpc.error).toBeUndefined();
  return toolResult.parse(rpc.result);
}

function reply(result: unknown, status = 200) {
  outgoing.mockResolvedValueOnce(Response.json(result, { status }));
}

function sentRequest() {
  const [url, init] = outgoing.mock.calls[0] ?? [];
  return {
    url: z.string().parse(url),
    init: z.object({
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()),
      body: z.string().optional(),
    }).parse(init),
  };
}

const envelope = (results: unknown[], next: string | null = null) => ({
  count: results.length,
  next,
  previous: null,
  results,
});

beforeEach(() => {
  outgoing.mockReset();
  outgoing.mockRejectedValue(new Error("Unexpected outbound request"));
  vi.stubGlobal("fetch", outgoing);
});
afterEach(() => vi.unstubAllGlobals());

describe("routing, authentication and configuration", () => {
  it("rejects non-/mcp paths", async () => {
    const response = await dispatch(new Request("https://ripe-atlas-mcp.example/other", {
      headers: { Authorization: `Bearer ${bindings.MCP_AUTH_TOKEN}` },
    }));
    expect(response.status).toBe(404);
  });

  it("serves a public MCP server card with the favicon as icon, without credentials", async () => {
    const response = await dispatch(new Request("https://ripe-atlas-mcp.example/.well-known/mcp/server-card/mcp"));
    expect(response.status).toBe(200);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    const card = z.object({
      name: z.string(),
      title: z.string(),
      icons: z.array(z.object({ src: z.string() })),
      remotes: z.array(z.object({ url: z.string() })),
    }).parse(await response.json());
    expect(card.title).toBe("RIPE Atlas");
    expect(card.icons[0]?.src).toBe("https://ripe-atlas-mcp.example/favicon.ico");
    expect(card.remotes[0]?.url).toBe("https://ripe-atlas-mcp.example/mcp");
    expect(outgoing).not.toHaveBeenCalled();
  });

  it.each(["", "Bearer wrong", "Basic abc", `Bearer ${"x".repeat(43)}`])("rejects invalid credentials: %s", async (authorization) => {
    const response = await dispatch(request("tools/list", {}, { Authorization: authorization }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("returns 503 when the service is not configured", async () => {
    const response = await dispatch(request("tools/list"), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The service is not configured: RIPE_ATLAS_API_KEY, MCP_AUTH_TOKEN.",
    });
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("names the invalid binding in the 503, without leaking its value", async () => {
    const response = await dispatch(request("tools/list"), {
      RIPE_ATLAS_API_KEY: "not a valid key",
      MCP_AUTH_TOKEN: "test-mcp-token-with-at-least-32-characters",
    });
    expect(response.status).toBe(503);
    const body = z.object({ error: z.string() }).parse(await response.json());
    expect(body.error).toContain("RIPE_ATLAS_API_KEY");
    expect(body.error).not.toContain("not a valid key");
  });

  it("lists all tools", async () => {
    const response = await dispatch(request("tools/list"));
    const rpc = await readRpc(response);
    const tools = z.object({
      tools: z.array(z.object({ name: z.string() })),
    }).parse(rpc.result);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "create_measurement",
      "get_measurement",
      "get_measurement_results",
      "get_probe",
      "list_measurements",
      "list_my_measurements",
      "list_probes",
      "stop_measurement",
    ]);
  });
});

describe("tools", () => {
  it("list_probes queries the Atlas API with the API key, not the MCP token", async () => {
    reply(envelope([{ id: 1000, country_code: "NL" }]));
    const result = await call("list_probes", { country: "NL" });
    expect(result.isError).toBeFalsy();
    const { url, init } = sentRequest();
    expect(url).toBe("https://atlas.ripe.net/api/v2/probes/?country=NL&page_size=100");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Key ${bindings.RIPE_ATLAS_API_KEY}`);
    expect(JSON.stringify(init.headers)).not.toContain(bindings.MCP_AUTH_TOKEN);
    const content = z.object({ count: z.number(), results: z.array(z.object({ id: z.number() })) })
      .parse(result.structuredContent);
    expect(content.count).toBe(1);
    expect(content.results[0]?.id).toBe(1000);
  });

  it("list_my_measurements hits /measurements/my/", async () => {
    reply(envelope([{ id: 555 }]));
    await call("list_my_measurements", {});
    expect(sentRequest().url).toBe("https://atlas.ripe.net/api/v2/measurements/my/?page_size=100");
  });

  it("maps Atlas 429 to a RateLimited tool error", async () => {
    reply({ detail: "Request was throttled." }, 429);
    const result = await call("list_probes", {});
    expect(result.isError).toBe(true);
    const content = z.object({ code: z.literal("RateLimited"), status: z.literal(429) })
      .parse(result.structuredContent);
    expect(content.code).toBe("RateLimited");
  });

  it("maps Atlas 403 to a permissions hint", async () => {
    reply({ detail: "You do not have permission to perform this action." }, 403);
    const result = await call("list_my_measurements", {});
    expect(result.isError).toBe(true);
    expect(z.string().parse(result.structuredContent?.message)).toContain("permissions");
  });

  it("create_measurement posts definitions and probes and returns created IDs", async () => {
    reply([{ id: 111, status: "Ongoing" }]);
    const result = await call("create_measurement", {
      definitions: [{ type: "ping", target: "example.com", packets: 3 }],
      probes: [{ type: "country", value: "NL", requested: 10 }],
      is_oneoff: true,
    });
    expect(result.isError).toBeFalsy();
    const { url, init } = sentRequest();
    expect(url).toBe("https://atlas.ripe.net/api/v2/measurements/");
    expect(init.method).toBe("POST");
    const body = z.object({
      definitions: z.array(z.object({ type: z.literal("ping"), target: z.string() })),
      probes: z.array(z.object({ type: z.literal("country"), requested: z.number() })),
      is_oneoff: z.literal(true),
    }).parse(JSON.parse(z.string().parse(init.body)));
    expect(body.definitions[0]?.target).toBe("example.com");
    const content = z.object({ created: z.array(z.object({ id: z.number() })) })
      .parse(result.structuredContent);
    expect(content.created[0]?.id).toBe(111);
  });

  it("stop_measurement patches is_stopped", async () => {
    reply({ id: 5, is_stopped: true });
    const result = await call("stop_measurement", { measurement_id: 5 });
    expect(result.isError).toBeFalsy();
    const { url, init } = sentRequest();
    expect(url).toBe("https://atlas.ripe.net/api/v2/measurements/5/");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(z.string().parse(init.body))).toEqual({ is_stopped: true });
  });

  it("get_measurement_results follows next up to max_pages and summarizes rtt", async () => {
    reply(envelope([{ prb_id: 1, result: [{ rtt: 10 }, { rtt: 20 }] }],
      "https://atlas.ripe.net/api/v2/measurements/9/results/?page=2"));
    reply(envelope([{ prb_id: 2, result: [{ avg: 15 }] }]));
    const result = await call("get_measurement_results", { measurement_id: 9, max_pages: 2 });
    expect(result.isError).toBeFalsy();
    expect(outgoing).toHaveBeenCalledTimes(2);
    expect(sentRequestAt(1).url).toBe("https://atlas.ripe.net/api/v2/measurements/9/results/?page=2");
    const content = z.object({
      measurement_id: z.literal(9),
      count: z.number(),
      pages_fetched: z.literal(2),
      results: z.array(z.unknown()),
      summary: z.object({ samples: z.literal(3), min_ms: z.literal(10), avg_ms: z.literal(15), max_ms: z.literal(20) }),
    }).parse(result.structuredContent);
    expect(content.results).toHaveLength(2);
  });

  it("get_measurement_results respects max_pages=1 and reports the remaining next link", async () => {
    reply(envelope([{ prb_id: 1, result: [{ rtt: 42 }] }],
      "https://atlas.ripe.net/api/v2/measurements/9/results/?page=2"));
    const result = await call("get_measurement_results", { measurement_id: 9 });
    expect(outgoing).toHaveBeenCalledTimes(1);
    const content = z.object({
      pages_fetched: z.literal(1),
      next: z.string(),
      summary: z.object({ samples: z.literal(1), min_ms: z.literal(42) }),
    }).parse(result.structuredContent);
    expect(content.next).toContain("page=2");
  });

  it("get_probe fetches a single probe", async () => {
    reply({ id: 1000, country_code: "NL", status: { name: "Connected" } });
    const result = await call("get_probe", { probe_id: 1000 });
    expect(sentRequest().url).toBe("https://atlas.ripe.net/api/v2/probes/1000/");
    expect(z.object({ id: z.literal(1000) }).parse(result.structuredContent).id).toBe(1000);
  });
});

function sentRequestAt(index: number) {
  const [url, init] = outgoing.mock.calls[index] ?? [];
  return {
    url: z.string().parse(url),
    init: z.object({
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()),
      body: z.string().optional(),
    }).parse(init),
  };
}
