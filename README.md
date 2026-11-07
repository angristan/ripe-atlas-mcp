# RIPE Atlas MCP

Query probes and measurements, fetch results, and create or stop measurements in [RIPE Atlas](https://atlas.ripe.net) from an MCP client. The server runs on Cloudflare Workers and proxies the Atlas REST API v2 with a server-side API key, so MCP clients never see the key.

Built with [Effect v4](https://effect.website/) and Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/), using Streamable HTTP at `/mcp`. It is stateless: no database, Durable Object, or LLM is required.

## Tools

| Tool | What it does |
| --- | --- |
| `list_probes` | List probes with filters: `search`, `country`, `asn`, `status`, `tags`, plus `page`/`page_size` |
| `get_probe` | Details of one probe by numeric ID |
| `list_measurements` | List public measurements, filterable by `status`, `type`, `target` |
| `list_my_measurements` | Measurements owned by the API key (needs the "List your measurements" key permission) |
| `get_measurement` | Details of one measurement by ID |
| `get_measurement_results` | Results for a measurement, with `start`/`stop` (Unix timestamps), `page_size`, `max_pages`, and an optional rtt/avg `summary` |
| `create_measurement` | Create a measurement (`ping`, `traceroute`, `dns`, `http`, `sslcert`, `ntp`) from selected probes |
| `stop_measurement` | Stop a running measurement (`is_stopped`) |

### Limits

- Creating a measurement **spends credits** from the API key's account, and the Atlas creation endpoint has stricter rate limits than read endpoints. Failed creations are never retried automatically; check before retrying, because a retry may create a second billed measurement.
- The Atlas API returns **HTTP 429** when rate limited. The server surfaces it as a `RateLimited` tool error and does not retry; wait a few seconds before calling again.
- `page_size` is capped at 500 by the Atlas API. `get_measurement_results` follows the `next` link up to `max_pages` (1–5, default 1); each page is one upstream request, and a Free-plan Worker allows 50 subrequests per invocation.
- Probe locations are obfuscated by RIPE Atlas for all users.
- The API key is sent as an `Authorization: Key` header, never in a URL.

## Setup

Requires Bun and Node.js 22 or 24+.

1. Create a RIPE Atlas API key: log in at [atlas.ripe.net](https://atlas.ripe.net) with your RIPE NCC Access account, then account menu → **API Keys** → new key. The **Key type** dropdown (Maintainer / My Resources / IP Analyser) is only a preset of grants, and options that don't apply to your account are greyed out — that's fine. Pick any available type, then add these grants manually in the Permission dropdown: **Create new measurement** and **List your measurements** (target: all). The key value is shown only once — copy it immediately.
2. Generate an MCP token: `openssl rand -hex 32`. Do not reuse the Atlas key.

```sh
git clone <this repo>
cd ripe-atlas-mcp
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Fill in `.dev.vars`:

| Variable | Value |
| --- | --- |
| `RIPE_ATLAS_API_KEY` | API key from the Atlas UI |
| `MCP_AUTH_TOKEN` | Separate random token, 32–256 characters, for MCP clients |

Start the local Worker:

```sh
bun run types
bun run dev
```

The endpoint is `http://localhost:8787/mcp`. Local tool calls use the real Atlas API with your real key, including creations that spend credits.

## Deploy

You need a Cloudflare account and Wrangler authentication:

```sh
bunx --no-install wrangler login
```

The checked-in `wrangler.jsonc` targets an existing personal deployment. Before deploying your own instance:

1. Set `name` and `account_id` to your Worker and Cloudflare account.
2. Upload the two secrets (Wrangler prompts for each value):

   ```sh
   bunx --no-install wrangler secret put RIPE_ATLAS_API_KEY
   bunx --no-install wrangler secret put MCP_AUTH_TOKEN
   ```

3. Check and deploy:

   ```sh
   bun run check
   bun run deploy
   ```

The Worker uses a `workers.dev` hostname; preview URLs are disabled. `/favicon.ico` (the official RIPE Atlas icon) is public so clients like Vibe Work can display it. `/mcp` always requires authentication.

## Connect a client

Use a client that supports remote MCP over Streamable HTTP with a custom authorization header:

- **URL:** `https://<worker-hostname>/mcp` (or the local endpoint above)
- **Header:** `Authorization: Bearer <MCP_AUTH_TOKEN>`

There is no OAuth login flow. Cross-origin browser access is not configured; use a server-side MCP client.

**Vibe Work (chat.mistral.ai):** register the Worker as a custom connector — Connectors → Add Connector → Custom MCP Server, with the URL above and an API-key/Bearer auth method using `MCP_AUTH_TOKEN` — or programmatically with a Mistral API key that has the "Private and shared connectors" scope:

```sh
curl https://api.mistral.ai/v1/connectors \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ripe-atlas",
    "description": "RIPE Atlas probes and measurements",
    "server": "https://<worker-hostname>/mcp",
    "supported_auth_methods": [{
      "method_type": "api_key",
      "headers": [{ "name": "Authorization", "is_required": true, "is_secret": true, "value": "Bearer <MCP_AUTH_TOKEN>" }]
    }]
  }'
```

Then enable the connector in a Vibe Work conversation.

**Vibe CLI:** add `RIPE_ATLAS_MCP_TOKEN=<MCP_AUTH_TOKEN>` to `~/.vibe/.env`, then:

```sh
vibe mcp add ripe-atlas \
  --url https://<worker-hostname>/mcp \
  --transport streamable-http \
  --api-key-env RIPE_ATLAS_MCP_TOKEN
```

## CI/CD

The GitHub repo (`angristan/ripe-atlas-mcp`, branch `main`) is connected to this Worker via Workers Builds: every push to `main` runs `bun install --frozen-lockfile && bun run typecheck && bun run test` and then `bunx wrangler deploy`. The trigger lives in Cloudflare control-plane state (Builds API), not in this repo. Secrets are **not** set by builds; manage them with `wrangler secret put`.

Observability is fully enabled (logs, traces, invocation logs at 100% sampling) — see the Worker's Logs/Traces tabs in the dashboard or `wrangler tail`.

## Development

```sh
bun run check
```

This regenerates Worker types, checks TypeScript, runs tests in workerd, and bundles a deployment dry run. Tests mock outbound requests and never contact RIPE Atlas, so they never spend credits. The dry run does not deploy anything.

Individual commands: `bun run typecheck`, `bun run test`, `bun run build`. Run `bun run types` when your editor needs refreshed bindings. The generated `worker-configuration.d.ts` is ignored by Git.

## Security and failure handling

- The MCP token grants all eight tools, including measurement creation that spends Atlas credits. Anyone holding it can act on your Atlas account within the key's permissions. Configure client confirmations for writes; MCP tool hints do not enforce confirmation on the server.
- The Atlas API key never leaves the Worker: it is sent only as an `Authorization: Key` header to `atlas.ripe.net`.
- Keep `.dev.vars`, both tokens, and authorization headers out of version control. Never put either token in a URL query string.
- Atlas requests time out after 30 seconds and follow client cancellation. Nothing is automatically retried. A failed or timed-out write may have completed; check the measurement list before retrying.
- MCP responses use `Cache-Control: no-store`. The application does not log tokens or raw Atlas errors. Avoid capturing request bodies or authorization headers in external logging tools.
