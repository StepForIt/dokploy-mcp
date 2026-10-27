// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{vault.…}}` is the Dokploy reference syntax, not a template
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./utils/apiClient.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("./utils/clientConfig.js", async () => {
  const { DEFAULT_REDACTED_FIELDS } = await import("./utils/redactSensitive.js");
  return { getClientConfig: () => ({ redactEnv: true, redactFields: DEFAULT_REDACTED_FIELDS }) };
});

const apiClient = (await import("./utils/apiClient.js")).default;
const { vaultTools, selectVariables, defaultKvPath } = await import("./vault-tools.js");
const { createHandler } = await import("./handler.js");

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);
const fetchMock = vi.fn();

const tool = vaultTools.find((t) => t.name === "env-migrate-to-vault");
if (!tool) throw new Error("missing tool");
const run = createHandler(tool);

const parse = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content.map((c) => c.text ?? "").join("\n"));

const PROVIDERS = [
  {
    vaultProviderId: "vp-1",
    name: "wappe",
    providerType: "hashicorp",
    config: { providerType: "hashicorp", url: "https://vault.test", token: "***", mount: "kv" },
  },
  { vaultProviderId: "vp-2", name: "inf", providerType: "infisical", config: {} },
];

const ENV = [
  "# comment",
  "PORT=3000",
  "AI_API_KEY=sk-live-abcdef",
  'SMTP_PASS="p@ss word"',
  "EMPTY_SECRET=",
  "DB_URL=${{vault.wappe.shared:DB_URL}}",
].join("\n");

function mockDokploy(env: string | null = ENV) {
  get.mockImplementation(async (url: string) => {
    if (url === "/vaultProvider.all") return { data: PROVIDERS };
    if (url === "/project.all") {
      return {
        data: [
          {
            projectId: "p1",
            name: "Wappe",
            environments: [
              {
                name: "app",
                applications: [],
                compose: [{ composeId: "c1", name: "App Prod" }],
              },
            ],
          },
        ],
      };
    }
    if (url === "/compose.one") return { data: { env } };
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockResolvedValue({ data: true });
}

/** A fake KV v2: `stored` is what the path holds; records writes. */
function mockVault(stored: Record<string, string> | null, version = 1) {
  const writes: Array<{ url: string; body: unknown }> = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method) {
      if (stored === null) return new Response("", { status: 404 });
      return Response.json({ data: { data: stored, metadata: { version } } });
    }
    writes.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ data: { version: version + 1 } });
  });
  return writes;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.VAULT_ADDR = "https://vault.test/";
  process.env.VAULT_TOKEN = "hvs.writer";
  delete process.env.VAULT_NAMESPACE;
});
afterEach(() => vi.unstubAllGlobals());

describe("selectVariables", () => {
  it("takes secrets only by default, keeps references and empties", () => {
    const { take, skipped } = selectVariables(ENV, { includeNonSecret: false });
    expect(take.map((t) => t.key)).toEqual(["AI_API_KEY", "SMTP_PASS"]);
    expect(take[1]?.value).toBe("p@ss word");
    expect(skipped).toEqual([
      { key: "PORT", reason: "not-secret" },
      { key: "EMPTY_SECRET", reason: "empty" },
      { key: "DB_URL", reason: "already-reference" },
    ]);
  });

  it("takes everything with includeNonSecret, or only the given keys", () => {
    expect(selectVariables(ENV, { includeNonSecret: true }).take.map((t) => t.key)).toEqual([
      "PORT",
      "AI_API_KEY",
      "SMTP_PASS",
    ]);
    const picked = selectVariables(ENV, { keys: ["PORT", "NOPE"], includeNonSecret: false });
    expect(picked.take.map((t) => t.key)).toEqual(["PORT"]);
    expect(picked.skipped).toContainEqual({ key: "NOPE", reason: "not-selected" });
  });
});

it("derives a lowercase KV path from project / environment / resource", () => {
  expect(
    defaultKvPath({
      resource: "compose",
      id: "x",
      name: "App Prod",
      project: "Wappe",
      environmentName: "app",
    }),
  ).toBe("wappe/app/app-prod");
});

describe("env-migrate-to-vault", () => {
  it("dry-run: lists the references without touching Dokploy or the vault", async () => {
    mockDokploy();
    const out = parse(await run({ provider: "wappe", resource: "compose", id: "c1" }));
    expect(out.data.applied).toBe(false);
    expect(out.data.targets[0].mount).toBe("kv");
    expect(out.data.targets[0].keys).toEqual([
      { key: "AI_API_KEY", reference: "${{vault.wappe.wappe/app/app-prod:AI_API_KEY}}" },
      { key: "SMTP_PASS", reference: "${{vault.wappe.wappe/app/app-prod:SMTP_PASS}}" },
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("sk-live");
  });

  it("writes the values to KV v2 with CAS, then replaces them by references in one env write", async () => {
    mockDokploy();
    const writes = mockVault({ OTHER: "keep" }, 4);
    const out = parse(
      await run({ provider: "wappe", resource: "compose", id: "c1", confirm: true }),
    );
    expect(out.data.targets[0].status).toBe("ok");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe("https://vault.test/v1/kv/data/wappe/app/app-prod");
    expect(writes[0]?.body).toEqual({
      data: { OTHER: "keep", AI_API_KEY: "sk-live-abcdef", SMTP_PASS: "p@ss word" },
      options: { cas: 4 },
    });
    expect(post).toHaveBeenCalledTimes(1);
    const env = String(post.mock.calls[0]?.[1]?.env);
    expect(env).toBe(
      [
        "# comment",
        "PORT=3000",
        "AI_API_KEY=${{vault.wappe.wappe/app/app-prod:AI_API_KEY}}",
        "SMTP_PASS=${{vault.wappe.wappe/app/app-prod:SMTP_PASS}}",
        "EMPTY_SECRET=",
        "DB_URL=${{vault.wappe.shared:DB_URL}}",
      ].join("\n"),
    );
    expect(out.data.redeployRequired).toEqual([
      { resource: "compose", id: "c1", name: "App Prod", project: "Wappe", environmentName: "app" },
    ]);
    expect(JSON.stringify(out)).not.toContain("sk-live");
  });

  it("leaves a conflicting field alone unless overwrite", async () => {
    mockDokploy();
    const writes = mockVault({ AI_API_KEY: "older-value" });
    const out = parse(
      await run({ provider: "wappe", resource: "compose", id: "c1", confirm: true }),
    );
    expect(out.data.targets[0].skipped).toContainEqual({ key: "AI_API_KEY", reason: "conflict" });
    expect(out.data.targets[0].migrated.map((m: { key: string }) => m.key)).toEqual(["SMTP_PASS"]);
    expect((writes[0]?.body as { data: Record<string, string> }).data.AI_API_KEY).toBe(
      "older-value",
    );
    expect(String(post.mock.calls[0]?.[1]?.env)).toContain("AI_API_KEY=sk-live-abcdef");

    post.mockClear();
    fetchMock.mockClear();
    mockVault({ AI_API_KEY: "older-value" });
    const forced = parse(
      await run({
        provider: "wappe",
        resource: "compose",
        id: "c1",
        confirm: true,
        overwrite: true,
      }),
    );
    expect(forced.data.targets[0].migrated.map((m: { key: string }) => m.key)).toEqual([
      "AI_API_KEY",
      "SMTP_PASS",
    ]);
  });

  it("creates the secret (cas 0) when the path is empty, and honours an explicit path", async () => {
    mockDokploy();
    const writes = mockVault(null);
    await run({
      provider: "wappe",
      resource: "compose",
      id: "c1",
      path: "shared/prod",
      confirm: true,
    });
    expect(writes[0]?.url).toBe("https://vault.test/v1/kv/data/shared/prod");
    expect((writes[0]?.body as { options: { cas: number } }).options.cas).toBe(0);
    expect(String(post.mock.calls[0]?.[1]?.env)).toContain(
      "${{vault.wappe.shared/prod:AI_API_KEY}}",
    );
  });

  it("on a vault failure, Dokploy is not touched", async () => {
    mockDokploy();
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    const out = parse(
      await run({ provider: "wappe", resource: "compose", id: "c1", confirm: true }),
    );
    expect(out.data.targets[0].status).toBe("vault-error");
    expect(out.data.targets[0].error).toBe("Vault read failed (HTTP 403)");
    expect(post).not.toHaveBeenCalled();
    expect(out.data.redeployRequired).toEqual([]);
  });

  it("on a Dokploy failure after the vault write, says the values are safe and to retry", async () => {
    mockDokploy();
    mockVault(null);
    post.mockRejectedValue(new Error("boom sk-live-abcdef"));
    const out = parse(
      await run({ provider: "wappe", resource: "compose", id: "c1", confirm: true }),
    );
    expect(out.data.targets[0].status).toBe("dokploy-error");
    expect(out.data.targets[0].error).toContain("call again to retry");
    expect(JSON.stringify(out)).not.toContain("sk-live");
  });

  it("refuses an unknown or non-HashiCorp provider, and a missing write token", async () => {
    mockDokploy();
    expect(parse(await run({ provider: "nope", resource: "compose", id: "c1" })).details).toContain(
      'provider "nope" not found',
    );
    expect(parse(await run({ provider: "inf", resource: "compose", id: "c1" })).details).toContain(
      "HashiCorp Vault / OpenBao only",
    );
    delete process.env.VAULT_TOKEN;
    const out = parse(
      await run({ provider: "wappe", resource: "compose", id: "c1", confirm: true }),
    );
    expect(out.details).toContain("VAULT_TOKEN");
    expect(post).not.toHaveBeenCalled();
  });

  it("takes a whole project and reports nothing-to-do on a resource without secrets", async () => {
    mockDokploy("PORT=3000");
    mockVault(null);
    const out = parse(await run({ provider: "wappe", project: "Wappe", confirm: true }));
    expect(out.data.targets[0].status).toBe("nothing-to-do");
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
