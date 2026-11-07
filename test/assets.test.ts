import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("public favicon", () => {
  it("serves the RIPE Atlas icon without credentials", async () => {
    const response = await env.ASSETS.fetch("https://ripe-atlas-mcp.example/favicon.ico");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^image\/(?:x-icon|vnd\.microsoft\.icon)/);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(4, true)).toBeGreaterThan(0);
    expect(bytes.length).toBeGreaterThan(22);
  });

  it("supports HEAD requests without returning the icon body", async () => {
    const response = await env.ASSETS.fetch(new Request("https://ripe-atlas-mcp.example/favicon.ico", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Type")).toMatch(/^image\/(?:x-icon|vnd\.microsoft\.icon)/);
  });
});
