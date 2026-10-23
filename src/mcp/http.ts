import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NutritionService } from "../app/nutritionService.ts";
import type { Logger } from "../infra/logger.ts";
import { buildMcpServer } from "./server.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface HttpServerOptions {
  service: NutritionService;
  authToken: string;
  logger: Logger;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/**
 * HTTP front end: `GET /health` (no auth) and `POST /mcp` (bearer token), using the stateless streamable HTTP
 * transport: every request gets a fresh MCP server, so no session state lives in memory.
 */
export function createHttpServer({ service, authToken, logger }: HttpServerOptions): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return sendJson(res, 200, { ok: true });
    if (path !== "/mcp") return sendJson(res, 404, { error: "not_found" });
    if (!authorized(req, authToken)) {
      return sendJson(
        res,
        401,
        { error: "unauthorized" },
        { "www-authenticate": 'Bearer realm="nutrition-mcp"' },
      );
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
    }

    const started = Date.now();
    const server = buildMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
      logger.debug("mcp request", { ms: Date.now() - started, status: res.statusCode });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error("mcp request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });
}
