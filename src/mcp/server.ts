import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NutritionService } from "../app/nutritionService.ts";
import { SOURCE_IDS } from "../domain/types.ts";

export const SERVER_INFO = { name: "etiquette-mcp", version: "0.3.0" } as const;

const sourcesSchema = z
  .array(z.enum(SOURCE_IDS))
  .optional()
  .describe("Only use these sources (default: all). Ids: " + SOURCE_IDS.join(", "));

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function respond(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
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
      "some sources did not answer yet: retry after retry_after_s instead of treating the result as final. sources " +
      "lists every source: 'skipped' means it was not needed for this request (e.g. Open Food Facts name search " +
      "when stores found the product) or the answer came from the cache. Scores range from 0 to 1.",
  });

  server.registerTool(
    "find_product",
    {
      title: "Find a food product",
      description:
        "Searches all sources by barcode, name or keywords and returns up to 5 products, each with a relevance score, " +
        "a macro preview when a label is available (label_preview), and the stores selling it (price, stock, link). " +
        "no_good_match: true means the best result is probably not what was asked for; requested_brand_found: false " +
        "means the brand given was not found. For the full label, pass a product_ref to get_label.",
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
        "nutrients). ready_to_apply gives flat values to store; nutrients the sources disagree on stay null there and " +
        "are listed in ready_to_apply.conflicts. Accepts a barcode directly, a product_ref from find_product, or a " +
        "product description (returns candidates with label_preview if ambiguous). status 'incomplete' means sources " +
        "timed out or were rate limited: retry later.",
      inputSchema: {
        product: z
          .string()
          .min(2)
          .max(200)
          .describe("product_ref (ean:… / grp:…), a barcode, or a product description"),
        brand: z.string().max(60).optional().describe("Brand, when passing a description"),
        sources: sourcesSchema,
        include_raw: z.boolean().optional().describe("Include per-source labels and raw text (default true)"),
        compact: z
          .boolean()
          .optional()
          .describe(
            "Leave out offers (stores only), per-source labels, ingredients, allergens, variants (default false)",
          ),
      },
      annotations: { title: "Get the best nutrition label", ...readOnly },
    },
    async ({ product, brand, sources, include_raw, compact }) => {
      try {
        return respond(
          await service.getLabel({
            product,
            brand,
            sources,
            includeRaw: include_raw,
            compact,
          }),
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
        "receipt. Faster and kinder to rate limits than separate calls: Open Food Facts lookups are combined. Each " +
        "item is a string or {product, brand?}. Returns one result per input, in order, compact by " +
        "default (stores instead of offers; no per-source labels, ingredients or variants).",
      inputSchema: {
        products: z
          .array(
            z.union([
              z.string().min(2).max(200),
              z.object({
                product: z.string().min(2).max(200),
                brand: z.string().max(60).optional(),
              }),
            ]),
          )
          .min(1)
          .max(20)
          .describe("Barcodes, product_refs or descriptions, optionally with a brand"),
        sources: sourcesSchema,
        include_raw: z
          .boolean()
          .optional()
          .describe("Include per-source labels and raw text when compact is false (default false)"),
        compact: z.boolean().optional().describe("Compact results (default true)"),
      },
      annotations: { title: "Get nutrition labels for several products", ...readOnly },
    },
    async ({ products, sources, include_raw, compact }) => {
      try {
        const items = products.map((p) =>
          typeof p === "string" ? p : { product: p.product, brand: p.brand },
        );
        return respond(
          await service.getLabels({ products: items, sources, includeRaw: include_raw, compact }),
        );
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
        "Every store selling the exact same product (same barcode, or same brand, name and size), cheapest total " +
        "price first, with the price spread. Prices are online list prices at lookup time.",
      inputSchema: {
        product: z.string().min(2).max(200).describe("Barcode, product_ref or description"),
        brand: z.string().max(60).optional().describe("Brand, when passing a description"),
        sources: sourcesSchema,
      },
      annotations: { title: "Compare prices across stores", ...readOnly },
    },
    async ({ product, brand, sources }) => {
      try {
        return respond(await service.comparePrices({ product, brand, sources }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List data sources",
      description:
        "Lists the sources with their capabilities and recent health, to explain missing data, and the server " +
        "version (it changes when tools change).",
      inputSchema: {},
      annotations: { title: "List data sources", ...readOnly, openWorldHint: false },
    },
    async () => respond({ server_version: SERVER_INFO.version, sources: service.listSources() }),
  );

  return server;
}
