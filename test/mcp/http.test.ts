import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NutritionService } from "../../src/app/nutritionService.ts";
import { loadConfig } from "../../src/config.ts";
import type { Offer } from "../../src/domain/types.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HealthTracker } from "../../src/infra/health.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { createHttpServer } from "../../src/mcp/http.ts";
import { SERVER_INFO } from "../../src/mcp/server.ts";
import type { SourceAdapter } from "../../src/sources/adapter.ts";

const TOKEN = "s".repeat(40);
const EAN = "3760109052641";

const product: Offer = {
  source: "off",
  sourceProductId: EAN,
  url: `https://world.openfoodfacts.org/product/${EAN}`,
  name: "Pain intégral",
  brand: "Montignac",
  ean: EAN,
  sizeText: "1 kg",
  priceEur: null,
  inStock: null,
  label: {
    source: "off",
    basis: "100g",
    values: {
      energy_kcal: { value: 230 },
      fat_g: { value: 1 },
      carbohydrates_g: { value: 44 },
      protein_g: { value: 6.8 },
    },
    extra: [],
    raw: null,
    ingredients: "Farine de blé complète",
    allergens: "gluten",
    traces: null,
    nutriscore: "b",
    parseStatus: "partial",
    url: null,
    fetchedAt: "2026-10-23T00:00:00Z",
  },
};

const offAdapter: SourceAdapter = {
  id: "off",
  tier: "A",
  displayName: "Open Food Facts",
  capabilities: { text: true, ean: true },
  search: async (q) => (q.ean === EAN || q.text ? [product] : []),
  getLabel: async (o) => ({ label: o.label ?? null }),
};

let baseUrl = "";
const server = createHttpServer({
  service: new NutritionService([offAdapter], {
    cache: new Cache(":memory:"),
    health: new HealthTracker(),
    config: loadConfig({ MCP_AUTH_TOKEN: TOKEN }),
    logger: silentLogger,
  }),
  authToken: TOKEN,
  logger: silentLogger,
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function connect(token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("MCP over HTTP", () => {
  it("serves health without auth and rejects bad tokens", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${baseUrl}/other`)).status).toBe(404);
  });

  it("lists the tools and answers get_label through the official client", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_prices",
      "find_product",
      "get_generic_food",
      "get_label",
      "get_labels",
      "list_sources",
    ]);

    const result = await client.callTool({ name: "get_label", arguments: { product: EAN } });
    const data = result.structuredContent as {
      status: string;
      product: { ean: string };
      label: { nutrients: Record<string, { value: number }> };
    };
    expect(data.status).toBe("found");
    expect(data.product.ean).toBe(EAN);
    expect(data.label.nutrients.energy_kcal?.value).toBe(230);

    const sources = await client.callTool({ name: "list_sources", arguments: {} });
    expect(sources.structuredContent).toMatchObject({
      server_version: SERVER_INFO.version,
      generic_foods: { foods: expect.any(Number) },
    });
    const generic = await client.callTool({
      name: "get_generic_food",
      arguments: { query: "banane", limit: 1 },
    });
    expect(generic.structuredContent).toMatchObject({
      foods: [{ name: "Banane, chair sans peau, crue", basis: "100g" }],
      source: { name: expect.stringContaining("Ciqual") },
    });
    await client.close();
  });

  it("validates tool input", async () => {
    const client = await connect(TOKEN);
    const result = await client.callTool({ name: "find_product", arguments: { query: "x" } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
