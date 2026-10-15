import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import apiClient from "./utils/apiClient.js";
import { maskEnvValue } from "./utils/redactSensitive.js";
import { ENV_KEY_PATTERN, upsertEnvVar } from "./utils/upsertEnv.js";

/**
 * Sets ONE env variable on an application or a compose. With DOKPLOY_REDACT_ENV the client only
 * ever sees masked envs, so it cannot send back the full `env` that `*-update` expects without
 * wiping the secrets. This tool reads the real env server-side, rewrites the single variable and
 * saves it: the secrets never leave the MCP server and are never overwritten.
 */
function envUpsertTool(resource: "application" | "compose", idField: string): ToolDefinition {
  return {
    name: `${resource}-env-upsert`,
    description: `Set ONE environment variable on a Dokploy ${resource} (add it, or replace its value) without resending the whole env. Every other variable, including masked secrets, is kept as is. Use this instead of \`${resource}-update\` with \`env\`, which replaces the full env and would overwrite secrets with [REDACTED]. The value is written as-is after \`KEY=\` (quote it if needed, no line breaks). Takes effect at the next deploy.`,
    tag: resource,
    method: "POST",
    path: `/${resource}.update`,
    schema: z.object({
      [idField]: z.string().min(1),
      key: z.string().regex(ENV_KEY_PATTERN, "Invalid variable name"),
      value: z
        .string()
        .refine((v) => !/[\r\n]/.test(v), "The value must fit on one line")
        .refine(
          (v) => !v.includes("[REDACTED]"),
          "The value is a masked placeholder, not a real value",
        ),
    }),
    annotations: {
      title: `Set one ${resource} env variable`,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    maskInput: (input) => ({
      ...input,
      value: maskEnvValue(String(input.key), String(input.value)),
    }),
    run: async (input) => {
      const id = String(input[idField]);
      const key = String(input.key);
      const { data } = await apiClient.get(`/${resource}.one`, { params: { [idField]: id } });
      const current: unknown = data?.env;
      // Never rebuild an env from nothing because the read came back in an unexpected shape.
      if (current !== null && typeof current !== "string") {
        throw new Error(`Could not read the current env of ${resource} ${id}; nothing was changed`);
      }
      const { env, action } = upsertEnvVar(current, key, String(input.value));
      if (action !== "unchanged") {
        await apiClient.post(`/${resource}.update`, { [idField]: id, env });
      }
      return { [idField]: id, key, action, redeployRequired: action !== "unchanged", env };
    },
  };
}

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
  envUpsertTool("application", "applicationId"),
  envUpsertTool("compose", "composeId"),
];
