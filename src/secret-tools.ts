import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { daysUntil, formatExpiry, parseExpiry } from "./utils/envAnnotations.js";
import { describeEntry, type EnvLocation, loadInventory } from "./utils/envInventory.js";
import { type EnvResourceKind, ID_FIELD, readEnv, writeEnv } from "./utils/envStore.js";
import { looksSecret } from "./utils/redactSensitive.js";
import {
  ENV_KEY_PATTERN,
  readAnnotations,
  readEnvVars,
  setEnvAnnotation,
  unquoteEnvValue,
} from "./utils/upsertEnv.js";

// Tools that work across projects or on the normed comments of a variable. The values stay on the
// MCP server: no input, reply, log or error of these tools ever carries one.

const envKey = z.string().regex(ENV_KEY_PATTERN, "Invalid variable name");

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

interface KeyLocation extends EnvLocation {
  key: string;
}

function envExpiryReportTool(): ToolDefinition {
  return {
    name: "env-expiry-report",
    description:
      "List, across ALL projects, the secrets that are expired or expire soon, read from the normed comment above a variable (`# NAME exp : DD/MM/YYYY`). Also lists secrets that have no expiry date and dates that cannot be read. Never returns a value.",
    tag: "secrets",
    method: "GET",
    path: "/project.all",
    schema: z.object({
      withinDays: z
        .number()
        .int()
        .min(0)
        .max(3650)
        .optional()
        .describe("Report keys expiring within this many days (default 30)"),
    }),
    annotations: { title: "Secret expiry report", ...READ_ONLY },
    run: async (input) => {
      const withinDays = typeof input.withinDays === "number" ? input.withinDays : 30;
      const now = new Date();
      const { entries, unreadable } = await loadInventory();
      const expired: Array<KeyLocation & { expires: string; daysLeft: number }> = [];
      const expiring: Array<KeyLocation & { expires: string; daysLeft: number }> = [];
      const invalid: Array<KeyLocation & { written: string }> = [];
      const undated: KeyLocation[] = [];

      for (const entry of entries) {
        const annotations = readAnnotations(entry.env);
        for (const variable of readEnvVars(entry.env)) {
          const where = { ...describeEntry(entry), key: variable.name };
          const written = annotations.get(variable.name)?.exp;
          if (written === undefined) {
            if (looksSecret(variable.name, unquoteEnvValue(variable.raw))) undated.push(where);
            continue;
          }
          const date = parseExpiry(written);
          if (!date) {
            invalid.push({ ...where, written });
            continue;
          }
          const daysLeft = daysUntil(date, now);
          if (daysLeft < 0) expired.push({ ...where, expires: formatExpiry(date), daysLeft });
          else if (daysLeft <= withinDays) {
            expiring.push({ ...where, expires: formatExpiry(date), daysLeft });
          }
        }
      }
      expired.sort((a, b) => a.daysLeft - b.daysLeft);
      expiring.sort((a, b) => a.daysLeft - b.daysLeft);
      return {
        today: formatExpiry(now),
        withinDays,
        expired,
        expiring,
        undated,
        invalid,
        unreadable,
      };
    },
  };
}

function envSetExpiryTool(resource: EnvResourceKind): ToolDefinition {
  const idField = ID_FIELD[resource];
  return {
    name: `${resource}-env-set-expiry`,
    description: `Set or remove the expiry date of a variable of a Dokploy ${resource}: writes the normed comment \`# NAME exp : DD/MM/YYYY\` right above it. The value and every other line are untouched. Omit \`expires\` to remove the date.`,
    tag: resource,
    method: "POST",
    path: `/${resource}.update`,
    schema: z.object({
      [idField]: z.string().min(1),
      key: envKey,
      expires: z.string().optional().describe("DD/MM/YYYY; omit to remove the date"),
    }),
    annotations: {
      title: `Set ${resource} variable expiry`,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: async (input) => {
      const id = String(input[idField]);
      const key = String(input.key);
      const written = typeof input.expires === "string" ? input.expires : null;
      const date = written === null ? null : parseExpiry(written);
      if (written !== null && !date) {
        throw new Error(`Invalid date "${written}": expected DD/MM/YYYY, nothing was changed`);
      }
      const expires = date ? formatExpiry(date) : null;
      const result = setEnvAnnotation(await readEnv(resource, id), key, "exp", expires);
      if (result.action !== "unchanged") await writeEnv(resource, id, result.env);
      return { [idField]: id, key, expires, action: result.action };
    },
  };
}

export const secretTools: ToolDefinition[] = [
  envExpiryReportTool(),
  envSetExpiryTool("application"),
  envSetExpiryTool("compose"),
];
