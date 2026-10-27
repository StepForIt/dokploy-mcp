// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{vault.…}}` is the Dokploy reference syntax, not a template
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import apiClient from "./utils/apiClient.js";
import {
  describeEntry,
  type EnvEntry,
  type EnvLocation,
  listResources,
  withEnv,
} from "./utils/envInventory.js";
import { writeEnv } from "./utils/envStore.js";
import { looksSecret } from "./utils/redactSensitive.js";
import { safeMessage, ToolInputError } from "./utils/secretOps.js";
import { ENV_KEY_PATTERN, readEnvVars, unquoteEnvValue, upsertEnvVar } from "./utils/upsertEnv.js";
import {
  getVaultConfig,
  isSafeKvPath,
  readKv,
  type VaultConfig,
  VaultError,
  writeKv,
} from "./utils/vaultClient.js";

// Moves env values from Dokploy into HashiCorp Vault / OpenBao, one way. Dokploy keeps a
// reference (`${{vault.<provider>.<path>:<KEY>}}`, resolved at deploy time since Dokploy 0.30)
// and the value lives in the vault only. The value transits through this server, never through
// the chat.

const DOKPLOY_REF = /\$\{\{\s*(vault|project|environment)\./;
const PROVIDER_NAME = /^[A-Za-z0-9_-]+$/;

interface Provider {
  id: string;
  name: string;
  providerType: string;
  mount: string;
}

type Raw = Record<string, unknown>;

/** The secrets providers declared in Dokploy (Settings → Secrets), tokens never read. */
async function listProviders(): Promise<Provider[]> {
  const { data } = await apiClient.get("/vaultProvider.all");
  const rows: Raw[] = Array.isArray(data) ? (data as Raw[]) : [];
  return rows.map((row) => {
    const config = (row.config ?? {}) as Raw;
    return {
      id: String(row.vaultProviderId ?? ""),
      name: String(row.name ?? ""),
      providerType: String(row.providerType ?? config.providerType ?? ""),
      mount: String(config.mount ?? "secret"),
    };
  });
}

async function resolveProvider(name: string): Promise<Provider> {
  const providers = await listProviders();
  const found = providers.find((p) => p.name === name);
  if (!found) {
    const names = providers.map((p) => p.name).join(", ") || "none";
    throw new ToolInputError(`Secrets provider "${name}" not found in Dokploy (known: ${names})`);
  }
  if (found.providerType !== "hashicorp") {
    throw new ToolInputError(
      `Secrets provider "${name}" is of type ${found.providerType || "unknown"}; this tool writes to HashiCorp Vault / OpenBao only`,
    );
  }
  return found;
}

/** `<project>/<environment>/<resource>` as a KV path: lowercase, odd characters folded to `-`. */
export function defaultKvPath(entry: EnvLocation): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x";
  return [entry.project, entry.environmentName, entry.name].map(slug).join("/");
}

export function vaultReference(provider: string, path: string, key: string): string {
  return `\${{vault.${provider}.${path}:${key}}}`;
}

type SkipReason = "already-reference" | "empty" | "not-secret" | "not-selected" | "conflict";

interface Selection {
  take: Array<{ key: string; value: string }>;
  skipped: Array<{ key: string; reason: SkipReason }>;
}

/** Which variables of an env leave for the vault, and why the others stay. */
export function selectVariables(
  env: string | null,
  options: { keys?: string[] | undefined; includeNonSecret: boolean },
): Selection {
  const wanted = options.keys ? new Set(options.keys) : null;
  const take: Selection["take"] = [];
  const skipped: Selection["skipped"] = [];
  for (const variable of readEnvVars(env)) {
    const value = unquoteEnvValue(variable.raw);
    const skip = (reason: SkipReason) => skipped.push({ key: variable.name, reason });
    if (wanted && !wanted.has(variable.name)) continue;
    if (DOKPLOY_REF.test(value)) {
      skip("already-reference");
    } else if (value === "") {
      skip("empty");
    } else if (!wanted && !options.includeNonSecret && !looksSecret(variable.name, value)) {
      skip("not-secret");
    } else {
      take.push({ key: variable.name, value });
    }
  }
  if (wanted) {
    const present = new Set(readEnvVars(env).map((v) => v.name));
    for (const key of wanted) if (!present.has(key)) skipped.push({ key, reason: "not-selected" });
  }
  return { take, skipped };
}

interface Target {
  entry: EnvEntry;
  path: string;
  selection: Selection;
}

async function pickTargets(input: Record<string, unknown>): Promise<{
  targets: Target[];
  unreadable: EnvLocation[];
}> {
  const all = await listResources();
  let chosen = all;
  if (typeof input.resource === "string" && typeof input.id === "string") {
    chosen = all.filter((r) => r.resource === input.resource && r.id === input.id);
    if (chosen.length === 0) throw new ToolInputError("Resource not found");
  } else if (typeof input.project === "string") {
    chosen = all.filter((r) => r.project === input.project);
    if (typeof input.environmentName === "string") {
      chosen = chosen.filter((r) => r.environmentName === input.environmentName);
    }
    if (chosen.length === 0) throw new ToolInputError("No application or compose in that project");
  } else {
    throw new ToolInputError("Give either resource + id, or project (+ environmentName)");
  }
  const { entries, unreadable } = await withEnv(chosen);
  const explicitPath = typeof input.path === "string" ? input.path : undefined;
  if (explicitPath !== undefined && entries.length > 1) {
    throw new ToolInputError("`path` applies to one resource: give resource + id with it");
  }
  const keys = Array.isArray(input.keys) ? (input.keys as string[]) : undefined;
  const targets = entries.map((entry) => ({
    entry,
    path: explicitPath ?? defaultKvPath(entry),
    selection: selectVariables(entry.env, {
      keys,
      includeNonSecret: input.includeNonSecret === true,
    }),
  }));
  for (const t of targets) {
    if (!isSafeKvPath(t.path)) throw new ToolInputError(`Invalid vault path "${t.path}"`);
  }
  return { targets, unreadable };
}

interface MigratedKey {
  key: string;
  reference: string;
}

/**
 * One resource: writes its values into the vault (merged with what the path already holds), then
 * replaces them in Dokploy by their references, in one env write. A vault conflict (same field,
 * different value, no `overwrite`) leaves that key in Dokploy untouched.
 */
async function migrateOne(
  vault: VaultConfig,
  provider: Provider,
  target: Target,
  overwrite: boolean,
): Promise<{
  migrated: MigratedKey[];
  skipped: Selection["skipped"];
  vaultVersion?: number;
  status: "ok" | "nothing-to-do" | "vault-error" | "dokploy-error";
  error?: string;
}> {
  const { entry, path, selection } = target;
  const skipped = [...selection.skipped];
  if (selection.take.length === 0) return { migrated: [], skipped, status: "nothing-to-do" };

  let migrated: MigratedKey[] = [];
  let vaultVersion: number;
  try {
    const existing = await readKv(vault, provider.mount, path);
    const data = { ...(existing?.data ?? {}) };
    const toWrite: MigratedKey[] = [];
    for (const { key, value } of selection.take) {
      if (key in data && data[key] !== value && !overwrite) {
        skipped.push({ key, reason: "conflict" });
        continue;
      }
      data[key] = value;
      toWrite.push({ key, reference: vaultReference(provider.name, path, key) });
    }
    if (toWrite.length === 0) return { migrated: [], skipped, status: "nothing-to-do" };
    const unchanged =
      existing !== null && toWrite.every(({ key }) => existing.data[key] === data[key]);
    vaultVersion = unchanged
      ? existing.version
      : await writeKv(vault, provider.mount, path, data, existing?.version ?? 0);
    migrated = toWrite;
  } catch (error) {
    const message = error instanceof VaultError ? error.message : "Vault request failed";
    return { migrated: [], skipped, status: "vault-error", error: message };
  }

  try {
    let env = entry.env;
    for (const { key, reference } of migrated) env = upsertEnvVar(env, key, reference).env;
    await writeEnv(entry.resource, entry.id, env ?? "");
  } catch (error) {
    return {
      migrated,
      skipped,
      vaultVersion,
      status: "dokploy-error",
      error: `${safeMessage(error)}; the values are in the vault, Dokploy still holds them in clear: call again to retry`,
    };
  }
  return { migrated, skipped, vaultVersion, status: "ok" };
}

function envMigrateToVaultTool(): ToolDefinition {
  return {
    name: "env-migrate-to-vault",
    description:
      "Move environment variables OUT of Dokploy INTO HashiCorp Vault / OpenBao, one way: each value is written to the KV v2 secret at `<path>` (default `<project>/<environment>/<resource>`, lowercased) and replaced in Dokploy by the reference `${{vault.<provider>.<path>:<KEY>}}` that Dokploy (>= 0.30) resolves at deploy time. The value transits through the MCP server only, never through the chat, and is never read back from the vault. `provider` is the name of the HashiCorp provider declared in Dokploy (Settings → Secrets); the MCP server needs its own write token (VAULT_ADDR, VAULT_TOKEN, optional VAULT_NAMESPACE). Scope: one resource (`resource` + `id`) or a whole project (`project`, optionally `environmentName`). By default only secret-looking variables move (`includeNonSecret: true` takes all, `keys` picks some). Variables already holding a `${{…}}` reference or an empty value stay. A field already in the vault with another value is left alone unless `overwrite: true`. Without `confirm: true` nothing is written: the reply lists what would move. Does NOT redeploy: the reply lists the resources to redeploy, and the provider must be assigned to the project in Dokploy or the deploy fails.",
    tag: "secrets",
    method: "POST",
    path: "/application.update",
    schema: z.object({
      provider: z.string().regex(PROVIDER_NAME, "Invalid provider name"),
      resource: z.enum(["application", "compose"]).optional(),
      id: z.string().min(1).optional(),
      project: z
        .string()
        .min(1)
        .optional()
        .describe("Project name: every application and compose of it"),
      environmentName: z.string().min(1).optional().describe("With project: only that environment"),
      keys: z
        .array(z.string().regex(ENV_KEY_PATTERN, "Invalid variable name"))
        .min(1)
        .optional()
        .describe("Only these variables (secret or not)"),
      includeNonSecret: z.boolean().optional().describe("Move every variable, not just secrets"),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          "KV path under the provider's mount, one resource only (default project/environment/resource)",
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace a field the vault already holds with another value"),
      confirm: z.boolean().optional().describe("true to apply; otherwise a dry-run"),
    }),
    annotations: {
      title: "Migrate env variables to Vault",
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true,
    },
    run: async (input) => {
      const provider = await resolveProvider(String(input.provider));
      const { targets, unreadable } = await pickTargets(input);
      const overwrite = input.overwrite === true;
      const describe = (t: Target) => ({
        ...describeEntry(t.entry),
        path: t.path,
        mount: provider.mount,
      });

      if (input.confirm !== true) {
        return {
          applied: false,
          provider: provider.name,
          targets: targets.map((t) => ({
            ...describe(t),
            keys: t.selection.take.map(({ key }) => ({
              key,
              reference: vaultReference(provider.name, t.path, key),
            })),
            skipped: t.selection.skipped,
          })),
          unreadable,
          next: "Nothing was written. Call again with confirm: true to apply.",
        };
      }

      const vault = getVaultConfig();
      const results = [];
      const redeployRequired: EnvLocation[] = [];
      for (const target of targets) {
        const result = await migrateOne(vault, provider, target, overwrite);
        results.push({ ...describe(target), ...result });
        if (result.status === "ok" && result.migrated.length > 0) {
          redeployRequired.push(describeEntry(target.entry));
        }
      }
      return {
        applied: true,
        provider: provider.name,
        targets: results,
        redeployRequired,
        unreadable,
      };
    },
  };
}

export const vaultTools: ToolDefinition[] = [envMigrateToVaultTool()];
