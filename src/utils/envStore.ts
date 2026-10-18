import apiClient from "./apiClient.js";

export type EnvResourceKind = "application" | "compose";

export const ID_FIELD: Record<EnvResourceKind, string> = {
  application: "applicationId",
  compose: "composeId",
};

// Reads the real env server-side. Never rebuild an env from nothing because the read came back in
// an unexpected shape: that would wipe every other variable.
export async function readEnv(resource: EnvResourceKind, id: string): Promise<string | null> {
  const { data } = await apiClient.get(`/${resource}.one`, {
    params: { [ID_FIELD[resource]]: id },
  });
  const current: unknown = data?.env;
  if (current !== null && typeof current !== "string") {
    throw new Error(`Could not read the current env of ${resource} ${id}; nothing was changed`);
  }
  return current;
}

export async function writeEnv(resource: EnvResourceKind, id: string, env: string): Promise<void> {
  await apiClient.post(`/${resource}.update`, { [ID_FIELD[resource]]: id, env });
}
