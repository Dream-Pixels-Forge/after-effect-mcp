#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createAfterEffectsMcpServer } from "./mcp-server.js";

const DEFAULT_PORT = 3927;
const port = Number(process.env.AE_MCP_HTTP_PORT || process.env.PORT || DEFAULT_PORT);
const host = process.env.AE_MCP_HTTP_HOST || "127.0.0.1";
const endpointPath = process.env.AE_MCP_HTTP_PATH || "/mcp";
const authToken = process.env.AE_MCP_HTTP_TOKEN;
const allowedOrigins = (process.env.AE_MCP_HTTP_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const transports = new Map<string, StreamableHTTPServerTransport>();

function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowedOrigins.length === 0) return;

  const allowOrigin = allowedOrigins.includes(origin) || allowedOrigins.includes("*") ? origin : undefined;
  if (!allowOrigin) return;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,Mcp-Session-Id,Last-Event-ID,mcp-protocol-version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendRpcError(res: ServerResponse, statusCode: number, message: string) {
  sendJson(res, statusCode, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!authToken) return true;

  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const provided = bearer || req.headers["x-api-key"];
  if (typeof provided !== "string") return false;

  const expectedBuffer = Buffer.from(authToken);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = Number(process.env.AE_MCP_HTTP_MAX_BODY_BYTES || 1_000_000);

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (!bodyText) return undefined;
  return JSON.parse(bodyText);
}

async function getOrCreateTransport(req: IncomingMessage, body: unknown, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"];
  if (Array.isArray(sessionId)) {
    sendRpcError(res, 400, "Bad Request: multiple session IDs provided");
    return undefined;
  }

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      sendRpcError(res, 404, "Bad Request: unknown MCP session ID");
      return undefined;
    }
    return transport;
  }

  if (req.method !== "POST" || !isInitializeRequest(body)) {
    sendRpcError(res, 400, "Bad Request: initialize with POST before using this MCP session");
    return undefined;
  }

  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) transports.delete(id);
  };

  const server = createAfterEffectsMcpServer();
  await server.connect(transport);
  return transport;
}

const httpServer = createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      name: "after-effect-mcp-http-bridge",
      endpoint: endpointPath,
      authRequired: Boolean(authToken),
      sessions: transports.size,
    });
    return;
  }

  if (url.pathname !== endpointPath) {
    sendJson(res, 404, { ok: false, error: "Not found", endpoint: endpointPath });
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="after-effect-mcp"');
    sendRpcError(res, 401, "Unauthorized");
    return;
  }

  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    sendRpcError(res, 405, "Method not allowed");
    return;
  }

  try {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const transport = await getOrCreateTransport(req, body, res);
    if (!transport) return;
    await transport.handleRequest(req, res, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("after-effect-mcp HTTP bridge error:", message);
    if (!res.headersSent) {
      sendRpcError(res, 500, "Internal server error");
    }
  }
});

httpServer.listen(port, host, () => {
  console.error(`after-effect-mcp HTTP bridge listening on http://${host}:${port}${endpointPath}`);
  console.error(`Health check: http://${host}:${port}/health`);
  console.error(authToken ? "HTTP auth: bearer token required." : "HTTP auth: disabled. Set AE_MCP_HTTP_TOKEN before exposing this server.");
});

async function shutdown() {
  for (const transport of transports.values()) {
    await transport.close().catch(() => undefined);
  }
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
