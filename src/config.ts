import { Data, Effect, Option, Schema } from "effect";

export interface Bindings {
  RIPE_ATLAS_API_KEY?: string;
  MCP_AUTH_TOKEN?: string;
}

const ApiKey = Schema.String.check(
  Schema.isPattern(/^\S{16,128}$/),
);
const AuthToken = Schema.String.check(Schema.isBetweenLength(32, 256));

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly fields: readonly string[];
}> {}

export interface Config {
  readonly apiKey: string;
  readonly authToken: string;
}

export const loadConfig = Effect.fn("loadConfig")(function* (env: Bindings) {
  const apiKey = yield* Effect.option(Schema.decodeUnknownEffect(ApiKey)(env.RIPE_ATLAS_API_KEY));
  const authToken = yield* Effect.option(Schema.decodeUnknownEffect(AuthToken)(env.MCP_AUTH_TOKEN));
  if (Option.isNone(apiKey) || Option.isNone(authToken)) {
    const fields: string[] = [];
    if (Option.isNone(apiKey)) fields.push("RIPE_ATLAS_API_KEY");
    if (Option.isNone(authToken)) fields.push("MCP_AUTH_TOKEN");
    return yield* new ConfigurationError({ fields });
  }
  return {
    apiKey: apiKey.value,
    authToken: authToken.value,
  } satisfies Config;
});
