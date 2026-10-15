import { timingSafeEqual } from "node:crypto";

// Shared secret required on every request (except /health). The HTTP transport exposes the
// whole Dokploy API with an admin key: without it, anyone who finds the URL owns the server.
export function readAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.MCP_AUTH_TOKEN?.trim();
  if (token) {
    if (token.length < 32) throw new Error("MCP_AUTH_TOKEN must be at least 32 characters long");
    return token;
  }
  if (env.MCP_ALLOW_UNAUTHENTICATED === "true") return null;
  throw new Error(
    "MCP_AUTH_TOKEN is required in HTTP mode (set MCP_ALLOW_UNAUTHENTICATED=true only on a private network)",
  );
}

export function isAuthorized(
  expected: string,
  authorization: string | undefined,
  queryToken: string | undefined,
): boolean {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const given = bearer || queryToken;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
