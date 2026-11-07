import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Effect } from "effect";
import type { Config } from "./config";
import {
  createMeasurementInput,
  getMeasurementInput,
  getMeasurementResultsInput,
  getProbeInput,
  listMeasurementsInput,
  listMyMeasurementsInput,
  listProbesInput,
  stopMeasurementInput,
  type Operation,
} from "./contracts";
import { Atlas, AtlasLive } from "./atlas";

function result(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : { value },
    isError,
  };
}

export function createServer(config: Config, requestSignal: AbortSignal) {
  const server = new McpServer({ name: "ripe-atlas-mcp", version: "0.1.0" });
  const layer = AtlasLive(config);
  const run = (operation: Operation, signal: AbortSignal) => Effect.runPromise(
    Effect.gen(function* () {
      const atlas = yield* Atlas;
      return yield* atlas.execute(operation);
    }).pipe(
      Effect.map((value) => result(value)),
      Effect.catchTag("AtlasError", (error) => Effect.succeed(result({
        code: error.code,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
      }, true))),
      Effect.catchCause(() => Effect.succeed(result({
        code: "InternalError",
        message: "The tool failed. For writes its outcome is unknown; do not retry blindly.",
      }, true))),
      Effect.provide(layer),
    ),
    { signal: AbortSignal.any([signal, requestSignal]) },
  );
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  server.registerTool("list_probes", {
    description:
      "List RIPE Atlas probes with optional filters (search, country, asn, status, tags). Returns count and one page of results; page_size is capped at 500 by the Atlas API.",
    inputSchema: listProbesInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "list_probes", input }, ctx.mcpReq.signal));

  server.registerTool("get_probe", {
    description: "Get details of one RIPE Atlas probe by its numeric ID.",
    inputSchema: getProbeInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "get_probe", input }, ctx.mcpReq.signal));

  server.registerTool("list_measurements", {
    description:
      "List public RIPE Atlas measurements, filterable by status, type, and target. Returns count and one page of results.",
    inputSchema: listMeasurementsInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "list_measurements", input }, ctx.mcpReq.signal));

  server.registerTool("list_my_measurements", {
    description:
      "List the measurements owned by the configured API key. Requires the key permission \"List your measurements\".",
    inputSchema: listMyMeasurementsInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "list_my_measurements", input }, ctx.mcpReq.signal));

  server.registerTool("get_measurement", {
    description: "Get details of one RIPE Atlas measurement by its ID, including status and definition.",
    inputSchema: getMeasurementInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "get_measurement", input }, ctx.mcpReq.signal));

  server.registerTool("get_measurement_results", {
    description:
      "Fetch results of a measurement, following the API's next link up to max_pages (each page is one upstream request). Optionally summarizes rtt/avg values. Use start/stop (Unix timestamps) and max_pages to keep responses small.",
    inputSchema: getMeasurementResultsInput,
    annotations: readAnnotations,
  }, (input, ctx) => run({ name: "get_measurement_results", input }, ctx.mcpReq.signal));

  server.registerTool("create_measurement", {
    description:
      "Create a RIPE Atlas measurement (ping, traceroute, dns, http, sslcert, ntp) from selected probes. This spends credits from the API key's account and Atlas rate limits on creation are strict. Do not automatically retry a failed creation; a retry may create a second billed measurement. Returns the created measurement IDs.",
    inputSchema: createMeasurementInput,
    annotations: writeAnnotations,
  }, (input, ctx) => run({ name: "create_measurement", input }, ctx.mcpReq.signal));

  server.registerTool("stop_measurement", {
    description:
      "Stop a running measurement by setting is_stopped. Ask the user before stopping a measurement.",
    inputSchema: stopMeasurementInput,
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, (input, ctx) => run({ name: "stop_measurement", input }, ctx.mcpReq.signal));

  return server;
}
