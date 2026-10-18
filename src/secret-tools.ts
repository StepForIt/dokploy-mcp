import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { daysUntil, formatExpiry, parseExpiry } from "./utils/envAnnotations.js";
import { groupBySharedValue, type Occurrence, valueId } from "./utils/envGroups.js";
import {
  describeEntry,
  type EnvLocation,
  getVaultProjects,
  type Listed,
  listResources,
  loadInventory,
} from "./utils/envInventory.js";
import { type EnvResourceKind, ID_FIELD, readEnv, writeEnv } from "./utils/envStore.js";
import { looksSecret } from "./utils/redactSensitive.js";
import { putVariable, resolveSource, safeMessage, ToolInputError } from "./utils/secretOps.js";
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

const resourceKind = z.enum(["application", "compose"]);

// Flat on purpose: clients silently drop nested or rarely used parameters (see custom-tools.ts).
const sourceShape = {
  sourceKey: envKey.describe("Name of the variable to read the value from"),
  sourceResource: resourceKind.optional().describe("Type of the source resource (with sourceId)"),
  sourceId: z.string().min(1).optional().describe("Id of the source application or compose"),
  sourceVault: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of a vault project (DOKPLOY_VAULT_PROJECTS) to find the variable in, instead of sourceResource + sourceId",
    ),
};

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

/** Every secret-looking variable of the given inventory, with what the comparison needs. */
function secretOccurrences(
  entries: Awaited<ReturnType<typeof loadInventory>>["entries"],
): Occurrence[] {
  return entries.flatMap((entry) => {
    const annotations = readAnnotations(entry.env);
    return readEnvVars(entry.env).flatMap((variable) => {
      const value = unquoteEnvValue(variable.raw);
      if (value === "" || !looksSecret(variable.name, value)) return [];
      const notes = annotations.get(variable.name);
      return [
        { ...describeEntry(entry), key: variable.name, value, src: notes?.src, exp: notes?.exp },
      ];
    });
  });
}

function envAuditDuplicatesTool(): ToolDefinition {
  return {
    name: "env-audit-duplicates",
    description:
      "Find, across ALL projects, the secrets that share the same value or the same first or last 10 characters (a rotated key often keeps its prefix), to tell whether a key is still used and where. Reports per group: usages, distinct values, orphans (copies neither in a vault project nor tagged with their origin) and each location. Never returns a value or a part of it; `valueId` only tells two values apart.",
    tag: "secrets",
    method: "GET",
    path: "/project.all",
    schema: z.object({}),
    annotations: { title: "Audit duplicated secrets", ...READ_ONLY },
    run: async () => {
      const vaults = new Set(getVaultProjects());
      const { entries, unreadable } = await loadInventory();
      const groups = groupBySharedValue(secretOccurrences(entries)).map((group, index) => {
        const members = group.members.map(({ value, ...member }) => ({
          ...member,
          valueId: valueId(value),
          inVault: vaults.has(member.project),
        }));
        return {
          group: `g${index + 1}`,
          matchedBy: group.matchedBy,
          usages: members.length,
          distinctValues: new Set(members.map((m) => m.valueId)).size,
          orphans: members.filter((m) => !m.inVault && m.src === undefined).length,
          members,
        };
      });
      return { groups, unreadable };
    },
  };
}

function findListed(all: Listed[], resource: string, id: string): Listed | undefined {
  return all.find((r) => r.resource === resource && r.id === id);
}

function envCopyTool(): ToolDefinition {
  return {
    name: "env-copy",
    description:
      "Copy a variable's value to one or more applications/composes, in any project, under any name, WITHOUT the value ever being shown: it is read and written on the MCP server. Each target gets a normed comment `# NAME src : project/environment/resource/SOURCE_KEY` recording where it came from (used by `env-rotate`). The copy is frozen: later changes of the source are not followed until a rotation. Takes effect at the next deploy of each target. The source is a resource (sourceResource + sourceId) or a vault project (sourceVault).",
    tag: "secrets",
    method: "POST",
    path: "/application.update",
    schema: z.object({
      ...sourceShape,
      targets: z
        .array(
          z.object({
            resource: resourceKind,
            id: z.string().min(1),
            key: envKey
              .optional()
              .describe("Variable name on the target (default: same as the source)"),
          }),
        )
        .min(1)
        .max(50),
    }),
    annotations: {
      title: "Copy a variable between projects",
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: async (input) => {
      const all = await listResources();
      const source = await resolveSource(
        input as unknown as Parameters<typeof resolveSource>[0],
        all,
      );
      const targets = input.targets as Array<{
        resource: EnvResourceKind;
        id: string;
        key?: string;
      }>;
      const results = [];
      for (const target of targets) {
        const key = target.key ?? source.variable.name;
        const listed = findListed(all, target.resource, target.id);
        const place = listed ? describeEntry(listed) : { resource: target.resource, id: target.id };
        try {
          if (!listed) throw new ToolInputError("Target resource not found");
          if (listed.id === source.entry.id && key === source.variable.name) {
            throw new ToolInputError("A variable cannot be copied onto itself");
          }
          const action = await putVariable(
            target.resource,
            target.id,
            key,
            source.variable.raw,
            source.ref,
          );
          results.push({
            ...place,
            key,
            status: "ok",
            action,
            redeployRequired: action !== "unchanged",
          });
        } catch (error) {
          results.push({ ...place, key, status: "error", error: safeMessage(error) });
        }
      }
      return {
        source: { ...describeEntry(source.entry), key: source.variable.name },
        targets: results,
      };
    },
  };
}

export const secretTools: ToolDefinition[] = [
  envExpiryReportTool(),
  envSetExpiryTool("application"),
  envSetExpiryTool("compose"),
  envCopyTool(),
  envAuditDuplicatesTool(),
];
