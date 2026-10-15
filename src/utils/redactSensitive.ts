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

// Fields holding a dotenv-style string (KEY=value per line): only secret values are masked, so
// the client still sees every variable name and the harmless values (hosts, ports, flags).
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

const DOTENV_LINE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=)(.*)$/;

// A variable is a secret when its name says so (GOOGLE_CLIENT_SECRET, SMTP_PASS, NPM_AUTH,
// SIRENE_API_KEY…); APP_HOST, SMTP_PORT or ADMIN_EMAILS stay readable. Unambiguous words match
// anywhere in the name (DBPASSWORD, APISECRET), short ones only as a whole word (KEY, not KEYBOARD).
const SECRET_NAME_PARTS = [
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "SECRET",
  "TOKEN",
  "APIKEY",
  "CREDENTIAL",
  "PRIVATE",
  "AUTHORIZATION",
  "SERVICE_ACCOUNT",
  "SERVICEACCOUNT",
];
const SECRET_NAME_WORDS = new Set([
  "KEY",
  "KEYS",
  "PASS",
  "PWD",
  "AUTH",
  "USER",
  "USERNAME",
  "LOGIN",
  "CREDS",
  "SALT",
  "COOKIE",
  "SESSION",
  "SIGNATURE",
  "CERT",
  "DSN",
  "WEBHOOK",
  "BEARER",
]);

// A flag such as GOOGLE_AUTH_ENABLED=true leaks nothing, whatever its name.
const HARMLESS_VALUE = /^\s*["']?(true|false|yes|no|on|off|0|1)["']?\s*$/i;

// Values that are secrets whatever the variable is called: known key prefixes, PEM blocks.
const SECRET_VALUE =
  /^\s*["']?(ghp_|gho_|ghs_|github_pat_|glpat-|sk-|sk_live_|rk_live_|xox[abprs]-|GOCSPX-|AKIA|eyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN)/;

// A long opaque blob (random key, base64 of a JSON credentials file…) is a secret even under an
// innocent name such as FCM_SERVICE_ACCOUNT_JSON. Hosts, URLs, emails and client ids all carry a
// "." or ":" and stay readable.
const OPAQUE_VALUE =
  /^\s*["']?(?=[A-Za-z0-9+/=_-]*[0-9])(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{32,}["']?\s*$/;

// Credentials inside a URL (postgres://user:pass@host, https://key@sentry…): keep the rest.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_NAME_PARTS.some((part) => upper.includes(part))) return true;
  return upper.split(/[^A-Z0-9]+/).some((word) => SECRET_NAME_WORDS.has(word));
}

export function maskEnvValue(name: string, value: string): string {
  if (value.trim() === "") return value;
  if (SECRET_VALUE.test(value) || OPAQUE_VALUE.test(value)) return REDACTED_PLACEHOLDER;
  if (isSecretName(name) && !HARMLESS_VALUE.test(value)) return REDACTED_PLACEHOLDER;
  return value.replace(URL_CREDENTIALS, `$1${REDACTED_PLACEHOLDER}@`);
}

export function maskDotenv(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return line;
      const m = line.match(DOTENV_LINE);
      if (!m) return REDACTED_PLACEHOLDER;
      const [, head = "", name = "", value = ""] = m;
      return `${head}${maskEnvValue(name, value)}`;
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
