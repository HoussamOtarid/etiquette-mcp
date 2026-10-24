import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NutritionService } from "../app/nutritionService.ts";
import { SOURCE_IDS } from "../domain/types.ts";

export const SERVER_INFO = { name: "etiquette-mcp", version: "0.1.0" } as const;

const sourcesSchema = z
  .array(z.enum(SOURCE_IDS))
  .optional()
  .describe("Only use these sources (default: all). Ids: " + SOURCE_IDS.join(", "));

const expectedSchema = z.object({
  energy_kcal: z.number().nonnegative().optional(),
  fat_g: z.number().nonnegative().optional(),
  saturated_fat_g: z.number().nonnegative().optional(),
  carbohydrates_g: z.number().nonnegative().optional(),
  sugars_g: z.number().nonnegative().optional(),
  fiber_g: z.number().nonnegative().optional(),
  protein_g: z.number().nonnegative().optional(),
  salt_g: z.number().nonnegative().optional(),
});

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function respond(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: `error: ${message}` }] };
}

/** Builds the MCP server exposing the nutrition tools. One instance per HTTP request (stateless transport). */
export function buildMcpServer(service: NutritionService): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Nutrition labels for food products sold in France, cross-checked across several shops and Open Food Facts. " +
      "Use get_label with a barcode (no product_ref needed) or a product description; if it returns candidates, ask " +
      "the user which one and call get_label again with that product_ref. Values are per 100 g or 100 ml (see " +
      "label.basis). Follow the advice field: it says how far the label can be trusted. status 'incomplete' means " +
      "some sources did not answer yet: retry after retry_after_s instead of treating the result as final.",
  });

  server.registerTool(
    "find_product",
    {
      title: "Find a food product",
      description:
        "Searches all sources by barcode, name or keywords and returns up to 5 products, each with the stores " +
        "selling it (price, unit price, stock, link). Does not fetch nutrition labels: pass a product_ref to get_label.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(160)
          .describe("Barcode (EAN), product name or keywords, e.g. 'pain intégral montignac'"),
        brand: z.string().max(60).optional().describe("Brand, if known: greatly improves matching"),
        size: z.string().max(30).optional().describe("Pack size, e.g. '500 g' or '1 L'"),
        sources: sourcesSchema,
        limit: z.number().int().min(1).max(5).optional().describe("Number of products (default and max 5)"),
      },
      annotations: { title: "Find a food product", ...readOnly },
    },
    async ({ query, brand, size, sources, limit }) => {
      try {
        return respond(await service.findProduct({ query, brand, size, sources, limit }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_label",
    {
      title: "Get the best nutrition label",
      description:
        "Returns the best-supported nutrition label for one product: per-nutrient value with how many sources agree, " +
        "an overall confidence, flags (with confidence.flag_details naming the source and nutrient), advice, " +
        "ingredients, allergens, prices per store, and each source's structured and raw label (which may list extra " +
        "nutrients). Accepts a barcode directly, a product_ref from find_product, or a product description (returns " +
        "candidates if ambiguous). status 'incomplete' means sources timed out or were rate limited: retry later.",
      inputSchema: {
        product: z
          .string()
          .min(2)
          .max(200)
          .describe("product_ref (ean:… / grp:…), a barcode, or a product description"),
        brand: z.string().max(60).optional().describe("Brand, when passing a description"),
        sources: sourcesSchema,
        include_raw: z.boolean().optional().describe("Include per-source labels and raw text (default true)"),
        compare_to: expectedSchema
          .optional()
          .describe(
            "Values you already have (e.g. a logged entry), per 100 g/ml: returns a per-nutrient comparison",
          ),
      },
      annotations: { title: "Get the best nutrition label", ...readOnly },
    },
    async ({ product, brand, sources, include_raw, compare_to }) => {
      try {
        return respond(
          await service.getLabel({ product, brand, sources, includeRaw: include_raw, compareTo: compare_to }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_labels",
    {
      title: "Get nutrition labels for several products",
      description:
        "Batch version of get_label for up to 20 products (barcodes, product_refs or descriptions), e.g. a meal or a " +
        "receipt. Faster and kinder to rate limits than separate calls: Open Food Facts lookups are combined. Returns " +
        "one result per input, in order, without per-source raw labels unless include_raw is true.",
      inputSchema: {
        products: z
          .array(z.string().min(2).max(200))
          .min(1)
          .max(20)
          .describe("Barcodes, product_refs or descriptions"),
        sources: sourcesSchema,
        include_raw: z
          .boolean()
          .optional()
          .describe("Include per-source labels and raw text (default false)"),
      },
      annotations: { title: "Get nutrition labels for several products", ...readOnly },
    },
    async ({ products, sources, include_raw }) => {
      try {
        return respond(await service.getLabels({ products, sources, includeRaw: include_raw }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "compare_prices",
    {
      title: "Compare prices across stores",
      description:
        "mode same_product (default): every store selling one product, cheapest unit price (€/kg or €/L) first, with " +
        "the price spread. mode alternatives: products matching a description across stores (other brands and sizes " +
        "included), each with its cheapest offer, cheapest unit price first. When a label is known, adds € per 100 kcal " +
        "and € per 10 g protein. Prices are online list prices at lookup time.",
      inputSchema: {
        product: z.string().min(2).max(200).describe("Barcode, product_ref or description"),
        brand: z.string().max(60).optional().describe("Brand, when passing a description"),
        mode: z.enum(["same_product", "alternatives"]).optional().describe("Default same_product"),
        sources: sourcesSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("alternatives: number of products (default 10)"),
      },
      annotations: { title: "Compare prices across stores", ...readOnly },
    },
    async ({ product, brand, mode, sources, limit }) => {
      try {
        return respond(await service.comparePrices({ product, brand, mode, sources, limit }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List data sources",
      description: "Lists the sources with their capabilities and recent health, to explain missing data.",
      inputSchema: {},
      annotations: { title: "List data sources", ...readOnly, openWorldHint: false },
    },
    async () => respond({ sources: service.listSources() }),
  );

  return server;
}
