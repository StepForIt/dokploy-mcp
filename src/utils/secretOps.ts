import { refToString, type VarRef } from "./envAnnotations.js";
import {
  type EnvEntry,
  type EnvLocation,
  getVaultProjects,
  type Listed,
  withEnv,
} from "./envInventory.js";
import { type EnvResourceKind, readEnv, writeEnv } from "./envStore.js";
import { type EnvVar, readEnvVars, setEnvAnnotation, upsertEnvVar } from "./upsertEnv.js";

/** An error whose message is safe to show: it never carries a value. */
export class ToolInputError extends Error {}

/** What a client may be told about a failure: our own messages, never an upstream payload. */
export function safeMessage(error: unknown): string {
  return error instanceof ToolInputError ? error.message : "Dokploy request failed";
}

export interface SourceInput {
  sourceKey: string;
  sourceResource?: EnvResourceKind | undefined;
  sourceId?: string | undefined;
  sourceVault?: string | undefined;
}

export interface ResolvedSource {
  entry: EnvEntry;
  variable: EnvVar;
  ref: VarRef;
}

const where = (e: EnvLocation) => `${e.project}/${e.environmentName}/${e.name}`;

/** The variable a copy or rotation starts from: a resource by id, or a variable of a vault project. */
export async function resolveSource(input: SourceInput, all: Listed[]): Promise<ResolvedSource> {
  const byId = input.sourceResource !== undefined && input.sourceId !== undefined;
  if (byId === (input.sourceVault !== undefined)) {
    throw new ToolInputError(
      "Give the source either as sourceResource + sourceId, or as sourceVault",
    );
  }

  let candidates: Listed[];
  if (byId) {
    candidates = all.filter((r) => r.resource === input.sourceResource && r.id === input.sourceId);
    if (candidates.length === 0) throw new ToolInputError("Source resource not found");
  } else {
    if (!getVaultProjects().includes(input.sourceVault as string)) {
      throw new ToolInputError(
        `"${input.sourceVault}" is not a vault project: list it in DOKPLOY_VAULT_PROJECTS`,
      );
    }
    candidates = all.filter((r) => r.project === input.sourceVault);
    if (candidates.length === 0) throw new ToolInputError("Vault project not found");
  }

  const { entries } = await withEnv(candidates);
  const found = entries.flatMap((entry) =>
    readEnvVars(entry.env)
      .filter((v) => v.name === input.sourceKey)
      .map((variable) => ({ entry, variable })),
  );
  const [first] = found;
  if (!first) throw new ToolInputError(`Variable ${input.sourceKey} not found in the source`);
  if (found.length > 1) {
    const places = found.map((f) => `${where(f.entry)} (${f.entry.resource} ${f.entry.id})`);
    throw new ToolInputError(
      `Variable ${input.sourceKey} exists in several places, give sourceResource + sourceId: ${places.join(", ")}`,
    );
  }
  const { entry, variable } = first;
  return {
    entry,
    variable,
    ref: {
      project: entry.project,
      environment: entry.environmentName,
      resource: entry.name,
      key: variable.name,
    },
  };
}

export type PutAction = "created" | "updated" | "unchanged" | "tagged";

/**
 * Writes `raw` (the text after `KEY=`, quotes included) as the variable `key` of a resource and
 * tags its origin, in one read and one write. Returns what changed.
 */
export async function putVariable(
  resource: EnvResourceKind,
  id: string,
  key: string,
  raw: string,
  source: VarRef | null,
): Promise<PutAction> {
  const upserted = upsertEnvVar(await readEnv(resource, id), key, raw);
  const tagged = source
    ? setEnvAnnotation(upserted.env, key, "src", refToString(source))
    : { env: upserted.env, action: "unchanged" as const };
  if (upserted.action === "unchanged" && tagged.action === "unchanged") return "unchanged";
  await writeEnv(resource, id, tagged.env);
  return upserted.action === "unchanged" ? "tagged" : upserted.action;
}
