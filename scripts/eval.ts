/**
 * Scores a running server on a fixed set of real lookups (scripts/evalCases.ts), through MCP like any client.
 * Usage: EVAL_URL=<server>/mcp MCP_AUTH_TOKEN=<token> npm run eval [-- --check] [--json <file>] [case filter]
 * top 1: the answer (or first result) is the expected product; top 5: it is among the candidates or results.
 * With --check it exits non-zero when a case that is not a known gap misses the top 5.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { normalizeText } from "../src/domain/text.ts";
import { CASES, type EvalCase, type Expected } from "./evalCases.ts";

interface Item {
  ean?: string | null;
  name?: string | null;
  brand?: string | null;
}

interface Outcome {
  id: string;
  rank: number | null;
  gap?: string;
  answer: string;
  ms: number;
}

function matches(item: Item, expected: Expected): boolean {
  if (expected.ean) {
    const eans = Array.isArray(expected.ean) ? expected.ean : [expected.ean];
    if (item.ean && eans.includes(item.ean)) return true;
    if (!expected.name) return false;
  }
  if (!expected.name) return false;
  const text = ` ${normalizeText(`${item.name ?? ""} ${item.brand ?? ""}`)} `;
  const words = normalizeText(expected.name).split(" ");
  const brandWords = ` ${normalizeText(item.brand)} `;
  const brandOk =
    !expected.brand ||
    normalizeText(expected.brand)
      .split(" ")
      .every((w) => brandWords.includes(` ${w} `));
  return brandOk && words.every((w) => text.includes(` ${w}`));
}

/** The ranked items an answer offers: the product found first, then candidates, variants or results. */
function itemsOf(tool: EvalCase["tool"], r: Record<string, unknown>): Item[] {
  const list = (key: string) => (Array.isArray(r[key]) ? (r[key] as Item[]) : []);
  if (tool === "find_product") return list("products");
  if (tool === "get_generic_food") return list("foods");
  const product = r.product as Item | null;
  return [...(product ? [product] : []), ...list("candidates"), ...list("variants")];
}

async function run(client: Client, c: EvalCase): Promise<Outcome> {
  const started = Date.now();
  const res = await client.callTool({ name: c.tool, arguments: c.input });
  const r = (res.structuredContent ?? {}) as Record<string, unknown>;
  const items = itemsOf(c.tool, r).slice(0, 5);
  const index = items.findIndex((item) => matches(item, c.expect));
  const found = c.tool !== "get_label" || r.status === "found";
  const rank = index < 0 ? null : index === 0 && found ? 1 : Math.max(index + 1, 2);
  const first = items[0];
  const answer = res.isError
    ? `error: ${JSON.stringify(res.content).slice(0, 80)}`
    : `${c.tool === "get_label" ? `${r.status} ` : ""}${first ? `${first.name ?? "?"} [${first.brand ?? "-"}] ${first.ean ?? ""}` : "-"}`;
  return { id: c.id, rank, ...(c.gap ? { gap: c.gap } : {}), answer, ms: Date.now() - started };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const jsonAt = args.indexOf("--json");
  const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const filter = args.filter((a, i) => !a.startsWith("--") && (jsonAt < 0 || i !== jsonAt + 1))[0];
  const url = process.env.EVAL_URL ?? "http://localhost:3000/mcp";
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) throw new Error("MCP_AUTH_TOKEN is required");

  const client = new Client({ name: "etiquette-eval", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  // Cases for tools the server doesn't have (an older version) are left out, so versions can be compared.
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  const cases = CASES.filter((c) => (!filter || c.id.includes(filter)) && tools.has(c.tool));
  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const o = await run(client, c);
    outcomes.push(o);
    const mark = o.rank === 1 ? "top1" : o.rank ? `top${o.rank}` : "miss";
    console.log(`${mark.padEnd(5)} ${o.gap ? "gap " : "    "}${o.id.padEnd(30)} ${o.answer}  ${o.ms}ms`);
  }
  await client.close();

  const scored = outcomes.filter((o) => !o.gap);
  const gaps = outcomes.filter((o) => o.gap);
  const top1 = scored.filter((o) => o.rank === 1).length;
  const top5 = scored.filter((o) => o.rank !== null).length;
  console.log(`\ncases ${scored.length}: top1 ${top1}, top5 ${top5}, miss ${scored.length - top5}`);
  const closed = gaps.filter((o) => o.rank !== null);
  console.log(`known gaps ${gaps.length}: now passing ${closed.map((o) => o.id).join(", ") || "none"}`);
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(outcomes, null, 2)}\n`);
  if (check && top5 < scored.length) process.exitCode = 1;
}

await main();
