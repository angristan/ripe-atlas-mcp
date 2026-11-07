import { Data, Effect, Schema } from "effect";

export interface Bindings {
  RIPE_ATLAS_API_KEY?: string;
  MCP_AUTH_TOKEN?: string;
}

const Environment = Schema.Struct({
  RIPE_ATLAS_API_KEY: Schema.String.check(
    Schema.isPattern(/^[0-9a-fA-F-]{16,128}$/),
  ),
  MCP_AUTH_TOKEN: Schema.String.check(Schema.isBetweenLength(32, 256)),
});

export class ConfigurationError extends Data.TaggedError("ConfigurationError") {}

export interface Config {
  readonly apiKey: string;
  readonly authToken: string;
}

export const loadConfig = Effect.fn("loadConfig")(function* (env: Bindings) {
  const values = yield* Schema.decodeUnknownEffect(Environment)(env).pipe(
    Effect.mapError(() => new ConfigurationError()),
  );
  return {
    apiKey: values.RIPE_ATLAS_API_KEY,
    authToken: values.MCP_AUTH_TOKEN,
  } satisfies Config;
});
