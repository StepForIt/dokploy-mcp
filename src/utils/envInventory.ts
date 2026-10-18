import apiClient from "./apiClient.js";
import type { VarRef } from "./envAnnotations.js";
import { type EnvResourceKind, readEnv } from "./envStore.js";

export interface EnvLocation {
  resource: EnvResourceKind;
  id: string;
  name: string;
  project: string;
  // Not called `environment`: that name is masked as a dotenv blob in tool replies.
  environmentName: string;
}

export interface EnvEntry extends EnvLocation {
  projectId: string;
  env: string | null;
}

// `env` is undefined when the project listing did not carry it, to be read one by one.
export type Listed = Omit<EnvEntry, "env"> & { env: string | null | undefined };

type Raw = Record<string, unknown>;

const READ_CONCURRENCY = 10;

/** Projects that hold the reusable secrets (source of truth), comma-separated project names. */
export function getVaultProjects(): string[] {
  return (process.env.DOKPLOY_VAULT_PROJECTS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

const list = (value: unknown): Raw[] => (Array.isArray(value) ? (value as Raw[]) : []);

function collect(project: Raw, environmentName: string, source: Raw): Listed[] {
  const base = {
    projectId: String(project.projectId),
    project: String(project.name),
    environmentName,
  };
  const kinds: Array<[EnvResourceKind, string, string]> = [
    ["application", "applications", "applicationId"],
    ["compose", "compose", "composeId"],
  ];
  return kinds.flatMap(([resource, field, idField]) =>
    list(source[field]).map((item) => ({
      ...base,
      resource,
      id: String(item[idField]),
      name: String(item.name),
      env: item.env as string | null | undefined,
    })),
  );
}

function flatten(projects: Raw[]): Listed[] {
  return projects.flatMap((project) => {
    const environments = list(project.environments);
    // Older Dokploy versions have no environments: resources hang off the project.
    if (environments.length === 0) return collect(project, "default", project);
    return environments.flatMap((env) => collect(project, String(env.name), env));
  });
}

/** Every application and compose of every project, without reading their env yet. */
export async function listResources(): Promise<Listed[]> {
  const { data } = await apiClient.get("/project.all");
  return flatten(list(data));
}

/**
 * Reads the real env of the given resources. `unreadable` lists those whose env could not be
 * read (location only, never the error text which could echo a value).
 */
export async function withEnv(
  all: Listed[],
): Promise<{ entries: EnvEntry[]; unreadable: EnvLocation[] }> {
  const entries: EnvEntry[] = [];
  const unreadable: EnvLocation[] = [];

  for (let i = 0; i < all.length; i += READ_CONCURRENCY) {
    await Promise.all(
      all.slice(i, i + READ_CONCURRENCY).map(async (entry) => {
        try {
          const env = entry.env === undefined ? await readEnv(entry.resource, entry.id) : entry.env;
          entries.push({ ...entry, env });
        } catch {
          unreadable.push(describeEntry(entry));
        }
      }),
    );
  }
  const order = new Map(all.map((e, idx) => [e.id, idx]));
  entries.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { entries, unreadable };
}

/** Every application and compose of every project with its real env. */
export async function loadInventory(): Promise<{ entries: EnvEntry[]; unreadable: EnvLocation[] }> {
  return withEnv(await listResources());
}

export function describeEntry(entry: EnvLocation): EnvLocation {
  const { resource, id, name, project, environmentName } = entry;
  return { resource, id, name, project, environmentName };
}

export type RefLookup = { found: EnvEntry } | { error: "not-found" | "ambiguous" };

/** Resolves a provenance ref (names) to the one resource it points at. */
export function findByRef(entries: EnvEntry[], ref: VarRef): RefLookup {
  const matches = entries.filter(
    (e) =>
      e.project === ref.project && e.environmentName === ref.environment && e.name === ref.resource,
  );
  if (matches.length === 0) return { error: "not-found" };
  const [found] = matches;
  return matches.length === 1 && found ? { found } : { error: "ambiguous" };
}
