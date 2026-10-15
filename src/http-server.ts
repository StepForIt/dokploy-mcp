#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { createServer } from "./server.js";
import { isAuthorized, readAuthToken } from "./utils/httpAuth.js";
import { createLogger } from "./utils/logger.js";

const PORT = 3000;
const logger = createLogger("MCP-HTTP-Server");

// MCP spec (Streamable HTTP): a request carrying a session ID the server no longer knows (it
// restarted, or the session expired) MUST get a 404, which tells the client to re-initialize.
// A 400 leaves clients such as claude.ai connectors stuck on a dead session after every redeploy.
const SESSION_NOT_FOUND = "Session not found: re-initialize";

const jsonrpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

// When MCP transport takes over the raw Node response, we must prevent
// Hono/@hono/node-server from trying to write its own response headers.
// We return a Promise that NEVER resolves — the underlying Node response
// is already being handled by the MCP transport, so Hono must not touch it.
function neverResolve(): Promise<never> {
  return new Promise(() => {});
}

export async function main() {
  const authToken = readAuthToken();
  const app = new Hono<{ Bindings: HttpBindings }>();

  const transports = {
    streamable: {} as Record<string, StreamableHTTPServerTransport>,
    sse: {} as Record<string, SSEServerTransport>,
  };

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  if (authToken) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
      // Legacy SSE clients post to the /messages URL the server hands them, without the token:
      // the random sessionId was only issued after an authenticated GET /sse.
      if (c.req.path === "/messages") {
        const sid = c.req.query("sessionId");
        if (sid && transports.sse[sid]) return next();
      }
      if (isAuthorized(authToken, c.req.header("authorization"), c.req.query("token"))) {
        return next();
      }
      logger.warn("Rejected unauthenticated request", { path: c.req.path });
      return c.json(jsonrpcError(-32001, "Unauthorized"), 401);
    });
  } else {
    logger.warn(
      "MCP_ALLOW_UNAUTHENTICATED=true: HTTP endpoints are open to anyone who can reach them",
    );
  }

  // Modern Streamable HTTP - POST
  app.post("/mcp", async (c) => {
    const { incoming, outgoing } = c.env;
    try {
      const sessionId = c.req.header("mcp-session-id");
      let transport: StreamableHTTPServerTransport;
      const body = await c.req.json();

      if (sessionId && transports.streamable[sessionId]) {
        transport = transports.streamable[sessionId];
      } else if (sessionId) {
        return c.json(jsonrpcError(-32001, SESSION_NOT_FOUND), 404);
      } else if (!sessionId && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.streamable[sid] = transport;
            logger.info("New MCP session initialized", { sessionId: sid });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            logger.info("MCP session closed", { sessionId: transport.sessionId });
            delete transports.streamable[transport.sessionId];
          }
        };

        const server = createServer();
        await server.connect(
          transport as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
        );
      } else {
        return c.json(
          jsonrpcError(
            -32000,
            "Bad Request: No valid session ID or invalid initialization request",
          ),
          400,
        );
      }

      await transport.handleRequest(incoming, outgoing, body);
      return neverResolve();
    } catch (error) {
      logger.error("Error handling HTTP request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  // Modern Streamable HTTP - GET (SSE notifications)
  app.get("/mcp", async (c) => {
    const { incoming, outgoing } = c.env;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      return c.json(jsonrpcError(-32000, "Missing session ID"), 400);
    }
    if (!transports.streamable[sessionId]) {
      return c.json(jsonrpcError(-32001, SESSION_NOT_FOUND), 404);
    }

    try {
      const transport = transports.streamable[sessionId];
      await transport.handleRequest(incoming, outgoing);
      return neverResolve();
    } catch (error) {
      logger.error("Error handling GET request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  // Modern Streamable HTTP - DELETE (session termination)
  app.delete("/mcp", async (c) => {
    const { incoming, outgoing } = c.env;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      return c.json(jsonrpcError(-32000, "Missing session ID"), 400);
    }
    if (!transports.streamable[sessionId]) {
      return c.json(jsonrpcError(-32001, SESSION_NOT_FOUND), 404);
    }

    try {
      const transport = transports.streamable[sessionId];
      await transport.handleRequest(incoming, outgoing);

      if (transports.streamable[sessionId]) {
        logger.info("MCP session terminated", { sessionId });
        delete transports.streamable[sessionId];
      }
      return neverResolve();
    } catch (error) {
      logger.error("Error handling DELETE request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  // Legacy SSE endpoint
  app.get("/sse", async (c) => {
    const { outgoing } = c.env;
    try {
      const transport = new SSEServerTransport("/messages", outgoing);
      transports.sse[transport.sessionId] = transport;

      outgoing.on("close", () => {
        logger.info("Legacy SSE session closed", { sessionId: transport.sessionId });
        delete transports.sse[transport.sessionId];
      });

      const server = createServer();
      await server.connect(transport);
      logger.info("New legacy SSE session initialized", { sessionId: transport.sessionId });
      return neverResolve();
    } catch (error) {
      logger.error("Error handling SSE request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  // Legacy message endpoint
  app.post("/messages", async (c) => {
    const { incoming, outgoing } = c.env;
    try {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json(jsonrpcError(-32000, "sessionId query parameter is required"), 400);
      }

      const transport = transports.sse[sessionId];
      if (!transport) {
        return c.json(jsonrpcError(-32001, SESSION_NOT_FOUND), 404);
      }

      const body = await c.req.json();
      await transport.handlePostMessage(incoming, outgoing, body);
      return neverResolve();
    } catch (error) {
      logger.error("Error handling legacy message request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonrpcError(-32603, "Internal server error"), 500);
    }
  });

  serve({ fetch: app.fetch, port: PORT }, () => {
    logger.info("MCP Dokploy server started", {
      port: PORT,
      protocols: ["Streamable HTTP (MCP 2025-03-26)", "Legacy SSE (MCP 2024-11-05)"],
      endpoints: {
        modern: `http://localhost:${PORT}/mcp`,
        legacy: `http://localhost:${PORT}/sse`,
        health: `http://localhost:${PORT}/health`,
      },
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error("Fatal error occurred", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
