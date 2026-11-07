import { Context, Data, Effect, Layer, Schema } from "effect";
import type { Config } from "./config";
import type { Operation } from "./contracts";

const API_BASE = "https://atlas.ripe.net/api/v2";

const ListEnvelope = Schema.Struct({
  count: Schema.Number,
  next: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
  results: Schema.Array(Schema.Unknown),
});
const HasId = Schema.Struct({ id: Schema.Number });

type ErrorCode =
  | "TransportError"
  | "InvalidResponse"
  | "RateLimited"
  | "NotFound"
  | "AtlasRejected"
  | "AtlasUnavailable";

export class AtlasError extends Data.TaggedError("AtlasError")<{
  readonly code: ErrorCode;
  readonly message: string;
  readonly status?: number;
}> {}

export class Atlas extends Context.Service<Atlas, {
  readonly execute: (operation: Operation) => Effect.Effect<unknown, AtlasError>;
}>()("ripe-atlas-mcp/Atlas") {}

const invalidResponse = () => new AtlasError({
  code: "InvalidResponse",
  message: "RIPE Atlas returned an invalid response.",
});

const extractDetail = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["detail", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "object" && value !== null) {
      const nested = (value as Record<string, unknown>)["detail"];
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return undefined;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Collects numeric rtt/avg values from result rows (ping packets, traceroute hops).
const summarize = (rows: readonly unknown[]): Record<string, unknown> | undefined => {
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const result = (row as { result?: unknown }).result;
    if (!Array.isArray(result)) continue;
    for (const entry of result) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      for (const key of ["rtt", "avg"]) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          count += 1;
          sum += value;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
  }
  if (count === 0) return undefined;
  return {
    samples: count,
    min_ms: round3(min),
    avg_ms: round3(sum / count),
    max_ms: round3(max),
  };
};

export const AtlasLive = (config: Config) => {
  const request = Effect.fn("Atlas.request")(function* (
    method: "GET" | "POST" | "PATCH",
    url: string,
    body: unknown,
  ) {
    const { status, body: responseBody } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Key ${config.apiKey}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal,
        });
        const parsed: unknown = await response.json().catch(() => null);
        return { status: response.status, body: parsed };
      },
      catch: () => new AtlasError({
        code: "TransportError",
        message: "The RIPE Atlas request failed. For writes the outcome is unknown; do not retry blindly.",
      }),
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", () => Effect.fail(new AtlasError({
        code: "TransportError",
        message: "The RIPE Atlas request timed out. For writes the outcome is unknown; do not retry blindly.",
      }))),
    );

    if (status >= 500) {
      return yield* new AtlasError({
        code: "AtlasUnavailable",
        message: "RIPE Atlas is unavailable. For writes the outcome is unknown; do not retry blindly.",
        status,
      });
    }
    if (status >= 300 && status < 400) {
      return yield* new AtlasError({
        code: "AtlasRejected",
        message: "RIPE Atlas returned an unexpected redirect. It was not followed.",
        status,
      });
    }
    if (status === 429) {
      return yield* new AtlasError({
        code: "RateLimited",
        message: "RIPE Atlas rate limit reached. No automatic retry was made; wait a few seconds and try again.",
        status,
      });
    }
    if (status === 404) {
      return yield* new AtlasError({
        code: "NotFound",
        message: "Not found in RIPE Atlas. Check the ID.",
        status,
      });
    }
    if (status === 401 || status === 403) {
      return yield* new AtlasError({
        code: "AtlasRejected",
        message: extractDetail(responseBody) ??
          "RIPE Atlas rejected the API key or its permissions. Check the key value, enabled flag, validity window, and grants.",
        status,
      });
    }
    if (status >= 400) {
      return yield* new AtlasError({
        code: "AtlasRejected",
        message: extractDetail(responseBody) ?? "RIPE Atlas rejected the request. Check the parameters.",
        status,
      });
    }
    return responseBody;
  });

  const list = Effect.fn("Atlas.list")(function* (
    path: string,
    query: Record<string, string | number | undefined>,
    maxPages: number,
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const queryString = params.toString();
    let url = `${API_BASE}${path}${queryString.length > 0 ? `?${queryString}` : ""}`;
    const results: unknown[] = [];
    let count = 0;
    let pagesFetched = 0;
    let next: string | null = null;
    while (pagesFetched < maxPages) {
      const body = yield* request("GET", url, undefined);
      const envelope = yield* Schema.decodeUnknownEffect(ListEnvelope)(body).pipe(
        Effect.mapError(invalidResponse),
      );
      count = envelope.count;
      results.push(...envelope.results);
      pagesFetched += 1;
      next = envelope.next;
      if (next === null || pagesFetched >= maxPages) break;
      if (!next.startsWith(API_BASE)) {
        return yield* new AtlasError({
          code: "InvalidResponse",
          message: "RIPE Atlas returned an unexpected next-page URL.",
        });
      }
      url = next;
    }
    return { count, pages_fetched: pagesFetched, next, results };
  });

  const getObject = Effect.fn("Atlas.getObject")(function* (path: string) {
    const body = yield* request("GET", `${API_BASE}${path}`, undefined);
    yield* Schema.decodeUnknownEffect(HasId)(body).pipe(Effect.mapError(invalidResponse));
    return body;
  });

  const execute = Effect.fn("Atlas.execute")(function* (operation: Operation) {
    switch (operation.name) {
      case "list_probes": {
        const input = operation.input;
        return yield* list("/probes/", {
          search: input.search,
          country: input.country,
          asn: input.asn,
          status: input.status,
          tags: input.tags,
          page: input.page,
          page_size: input.page_size,
        }, 1);
      }
      case "get_probe":
        return yield* getObject(`/probes/${operation.input.probe_id}/`);
      case "list_measurements": {
        const input = operation.input;
        return yield* list("/measurements/", {
          status: input.status,
          type: input.type,
          target: input.target,
          page: input.page,
          page_size: input.page_size,
        }, 1);
      }
      case "list_my_measurements": {
        const input = operation.input;
        return yield* list("/measurements/my/", {
          page: input.page,
          page_size: input.page_size,
        }, 1);
      }
      case "get_measurement":
        return yield* getObject(`/measurements/${operation.input.measurement_id}/`);
      case "get_measurement_results": {
        const input = operation.input;
        const listed = yield* list(`/measurements/${input.measurement_id}/results/`, {
          start: input.start,
          stop: input.stop,
          page_size: input.page_size,
        }, input.max_pages);
        const value: Record<string, unknown> = {
          measurement_id: input.measurement_id,
          ...listed,
        };
        const summary = input.summarize ? summarize(listed.results) : undefined;
        return summary === undefined ? value : { ...value, summary };
      }
      case "create_measurement": {
        const input = operation.input;
        const body = yield* request("POST", `${API_BASE}/measurements/`, {
          definitions: input.definitions,
          probes: input.probes,
          is_oneoff: input.is_oneoff,
          ...(input.bill_to === undefined ? {} : { bill_to: input.bill_to }),
        });
        yield* Schema.decodeUnknownEffect(Schema.Array(HasId))(body).pipe(
          Effect.mapError(invalidResponse),
        );
        return { created: body };
      }
      case "stop_measurement": {
        const measurementId = operation.input.measurement_id;
        const body = yield* request("PATCH", `${API_BASE}/measurements/${measurementId}/`, {
          is_stopped: true,
        });
        yield* Schema.decodeUnknownEffect(HasId)(body).pipe(Effect.mapError(invalidResponse));
        return body;
      }
    }
  });

  return Layer.succeed(Atlas, { execute });
};
