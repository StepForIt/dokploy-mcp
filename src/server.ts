import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ZodObject, ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { customTools } from "./custom-tools.js";
import { generatedTools } from "./generated/tools.js";
import { createHandler } from "./handler.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("MCP-Server");

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function getEnabledTools() {
  // Merge auto-generated tools with hand-written custom ones. Custom tools
  // exist to work around limitations of the catalog client (e.g. fields stripped
  // because the parent tool has too many params). See `src/custom-tools.ts`.
  const allTools = [...generatedTools, ...customTools];

  const enabledTags = process.env.DOKPLOY_ENABLED_TAGS;

  if (!enabledTags) {
    return allTools;
  }

  const tags = new Set(
    enabledTags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

  const filtered = allTools.filter((tool) => tags.has(tool.tag.toLowerCase()));

  logger.info("Filtered tools by tags", {
    enabledTags: [...tags],
    total: allTools.length,
    loaded: filtered.length,
  });

  return filtered;
}

function stripNestedSchemaKeys(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stripNestedSchemaKeys(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "$schema") {
      delete record[key];
    } else {
      stripNestedSchemaKeys(record[key]);
    }
  }
}

// Claude's API requires JSON Schema draft 2020-12. The MCP SDK's built-in
// Zod→JSON Schema converter emits draft-07 by default, which causes a 400
// error on tools/list. We bypass the SDK's auto-generated handler by
// registering our own with pre-converted draft-2020-12 schemas.
// See https://github.com/Dokploy/mcp/issues/32
function toDraft2020_12JsonSchema(schema: ZodObject<ZodRawShape>): Record<string, unknown> {
  const result = zodToJsonSchema(schema, {
    target: "jsonSchema2019-09",
    strictUnions: true,
  }) as Record<string, unknown>;

  stripNestedSchemaKeys(result);
  result.$schema = JSON_SCHEMA_2020_12;
  return result;
}

export function createServer() {
  const server = new McpServer({
    name: "dokploy",
    version: "2.0.0",
  });

  const tools = getEnabledTools();

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema.shape,
      tool.annotations ?? {},
      createHandler(tool),
    );
  }

  const toolList = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toDraft2020_12JsonSchema(tool.schema),
    annotations: tool.annotations,
  }));

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList,
  }));

  return server;
}
