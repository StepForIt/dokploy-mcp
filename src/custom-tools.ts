import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Custom tools that augment the auto-generated catalog from `src/generated/tools.ts`.
 *
 * Why they exist:
 *   The generated `compose-update` tool exposes ~44 optional parameters. When the MCP
 *   server publishes that schema, the client (Anthropic catalog) silently keeps only
 *   the ~12 most common parameters in the tool browser used by the model. Less common
 *   fields like `isolatedDeploymentsVolume` get strippped before the call reaches us,
 *   so updates to them are no-ops on the API side.
 *
 *   Each tool below carves out a narrowly-scoped slice of the underlying endpoint with
 *   a minimal schema (only the fields actually being changed), guaranteeing every
 *   parameter survives the client-side reduction.
 *
 * How to add a new one:
 *   1. Pick the endpoint + the small set of fields you want to set together.
 *   2. Declare a Zod schema with just those fields (the rest are left untouched
 *      on the server side — Dokploy's PATCH-style update only writes what you send).
 *   3. Append the tool to the array exported below.
 */
export const customTools: ToolDefinition[] = [
  {
    name: "compose-update-deployment-config",
    description:
      "POST /compose.update — narrow tool to toggle Dokploy compose deployment isolation flags (`isolatedDeployment` and `isolatedDeploymentsVolume`) and the `triggerType`. Use this instead of `compose-update` when you only want to change deployment behavior, since the broader tool silently drops these less-common fields before invocation.",
    tag: "compose",
    method: "POST",
    path: "/compose.update",
    schema: z.object({
      composeId: z.string(),
      isolatedDeployment: z.boolean().optional(),
      isolatedDeploymentsVolume: z.boolean().optional(),
      triggerType: z.union([z.enum(["push", "tag"]), z.null()]).optional(),
    }),
    annotations: {
      title: "Update compose deployment config",
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];
