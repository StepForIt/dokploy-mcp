export const DEFAULT_REDACTED_FIELDS = [
  "env",
  "buildArgs",
  "composeFile",
  "dockerCompose",
  "environment",
  "buildSecrets",
  "previewBuildSecrets",
  "password",
  "currentPassword",
  "appPassword",
  "databasePassword",
  "databaseRootPassword",
  "redisPassword",
  "mariadbPassword",
  "mongoPassword",
  "mysqlPassword",
  "postgresPassword",
  "registryPassword",
  "token",
  "accessToken",
  "appToken",
  "apiToken",
  "botToken",
  "refreshToken",
  "secret",
  "clientSecret",
  "apiKey",
  "secretAccessKey",
  "accessKey",
  "licenseKey",
  "userKey",
  "privateKey",
  "privateKeyPass",
  "encPrivateKey",
  "encPrivateKeyPass",
  "sshKey",
  "sshPrivateKey",
  "customGitSSHKey",
  "dockerAuth",
];

const REDACTED_PLACEHOLDER = "[REDACTED]";

// Fields holding a dotenv-style string (KEY=value per line): only the values are masked, so
// the client still sees which variables are set, which are empty, and how they are named.
const DOTENV_FIELDS = new Set([
  "env",
  "buildargs",
  "buildsecrets",
  "previewbuildsecrets",
  "environment",
]);

// Dokploy also returns an `environment` OBJECT (the project environment: id, name, nested env):
// walk into it instead of hiding it, its own secret-bearing fields are still redacted.
const WALKABLE_FIELDS = new Set(["environment"]);

const DOTENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=)(.*)$/;

export function maskDotenv(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return line;
      const m = line.match(DOTENV_LINE);
      if (!m) return REDACTED_PLACEHOLDER;
      const [, head = "", value = ""] = m;
      return value.trim() === "" ? head : `${head}${REDACTED_PLACEHOLDER}`;
    })
    .join("\n");
}

function redactValue(key: string, val: unknown, fields: Set<string>, seen: WeakSet<object>) {
  if (val === null || val === undefined) return val;
  if (WALKABLE_FIELDS.has(key) && (isPlainObject(val) || Array.isArray(val))) {
    return walk(val, fields, seen);
  }
  if (typeof val === "string" && DOTENV_FIELDS.has(key)) return maskDotenv(val);
  return REDACTED_PLACEHOLDER;
}

export function redactSensitive<T>(data: T, fields: string[]): T {
  if (fields.length === 0) return data;
  const lowered = new Set(fields.map((f) => f.toLowerCase()));
  return walk(data, lowered, new WeakSet()) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, fields: Set<string>, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => walk(item, fields, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const lowered = key.toLowerCase();
      if (fields.has(lowered)) {
        out[key] = redactValue(lowered, val, fields, seen);
      } else {
        out[key] = walk(val, fields, seen);
      }
    }
    return out;
  }
  return value;
}
