// Direct access to a HashiCorp Vault / OpenBao KV v2 engine. Dokploy only READS a vault at deploy
// time (`${{vault.<provider>.<path>:<field>}}`): moving a value out of Dokploy needs a writer, and
// that writer is this MCP server, with its own token (VAULT_TOKEN) scoped to the paths it fills.
// Nothing here ever hands a value back to Dokploy: the migration is one-way.

export interface VaultConfig {
  addr: string;
  token: string;
  namespace?: string;
}

export function getVaultConfig(): VaultConfig {
  const addr = (process.env.VAULT_ADDR ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.VAULT_TOKEN ?? "").trim();
  if (!addr) throw new Error("Environment variable VAULT_ADDR is not defined");
  if (!token) throw new Error("Environment variable VAULT_TOKEN is not defined");
  const namespace = (process.env.VAULT_NAMESPACE ?? "").trim();
  return namespace ? { addr, token, namespace } : { addr, token };
}

export interface KvSecret {
  data: Record<string, string>;
  /** Current version of the secret, 0 when it does not exist yet. */
  version: number;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A KV path is `a/b/c`: no empty, dotted or odd segments, so it cannot escape the mount. */
export function isSafeKvPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length > 0 && segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")
  );
}

function url(config: VaultConfig, mount: string, path: string): string {
  const seg = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `${config.addr}/v1/${seg(mount)}/data/${seg(path)}`;
}

function headers(config: VaultConfig): Record<string, string> {
  return {
    "X-Vault-Token": config.token,
    "Content-Type": "application/json",
    ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}),
  };
}

/** An error whose message never carries a value nor the token. */
export class VaultError extends Error {}

/** Reads a KV v2 secret; `null` when nothing is stored at that path yet. */
export async function readKv(
  config: VaultConfig,
  mount: string,
  path: string,
): Promise<KvSecret | null> {
  const response = await fetch(url(config, mount, path), { headers: headers(config) });
  if (response.status === 404) return null;
  if (!response.ok) throw new VaultError(`Vault read failed (HTTP ${response.status})`);
  const body = (await response.json()) as {
    data?: { data?: Record<string, unknown> | null; metadata?: { version?: number } };
  };
  const data = body.data?.data;
  // A deleted (not destroyed) version answers 200 with `data: null`: treat it as absent.
  if (!data) return null;
  const strings = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  return { data: strings, version: Number(body.data?.metadata?.version ?? 0) };
}

/**
 * Writes a KV v2 secret as a whole (KV v2 has no per-field write): the caller merges. `cas` is
 * the version read just before, so a concurrent write makes this one fail instead of being lost.
 */
export async function writeKv(
  config: VaultConfig,
  mount: string,
  path: string,
  data: Record<string, string>,
  cas: number,
): Promise<number> {
  const response = await fetch(url(config, mount, path), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ data, options: { cas } }),
  });
  if (!response.ok) throw new VaultError(`Vault write failed (HTTP ${response.status})`);
  const body = (await response.json().catch(() => ({}))) as {
    data?: { version?: number };
  };
  return Number(body.data?.version ?? cas + 1);
}
