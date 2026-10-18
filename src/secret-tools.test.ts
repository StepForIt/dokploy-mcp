import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./utils/apiClient.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("./utils/clientConfig.js", async () => {
  const { DEFAULT_REDACTED_FIELDS } = await import("./utils/redactSensitive.js");
  return { getClientConfig: () => ({ redactEnv: true, redactFields: DEFAULT_REDACTED_FIELDS }) };
});

const apiClient = (await import("./utils/apiClient.js")).default;
const { secretTools } = await import("./secret-tools.js");
const { createHandler } = await import("./handler.js");

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);

function tool(name: string) {
  const found = secretTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** Mocks a Dokploy with the given projects; `envs` maps a resource id to its real env. */
function mockDokploy(projects: unknown[], extraEnvs: Record<string, string | null> = {}) {
  const envs: Record<string, string | null> = { ...extraEnvs };
  for (const p of projects as Array<{
    environments: Array<Record<string, Array<Record<string, unknown>>>>;
  }>) {
    for (const e of p.environments) {
      for (const r of [...(e.applications ?? []), ...(e.compose ?? [])]) {
        const id = String(r.applicationId ?? r.composeId);
        if (!(id in envs)) envs[id] = (r.env as string | null | undefined) ?? null;
      }
    }
  }
  get.mockImplementation(async (url: string, opts?: { params?: Record<string, string> }) => {
    if (url === "/project.all") return { data: projects };
    const id = opts?.params?.applicationId ?? opts?.params?.composeId ?? "";
    return { data: { env: envs[id] ?? null } };
  });
  post.mockResolvedValue({ data: true });
}

function project(
  name: string,
  environmentName: string,
  resources: Array<{
    kind?: "application" | "compose";
    id: string;
    name: string;
    env?: string | null;
  }>,
) {
  const of = (kind: "application" | "compose") =>
    resources
      .filter((r) => (r.kind ?? "application") === kind)
      .map((r) => ({
        [kind === "application" ? "applicationId" : "composeId"]: r.id,
        name: r.name,
        ...(r.env === undefined ? {} : { env: r.env }),
      }));
  return {
    projectId: `proj-${name}`,
    name,
    environments: [
      { name: environmentName, applications: of("application"), compose: of("compose") },
    ],
  };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("env-expiry-report", () => {
  const env = [
    "# STRIPE_KEY exp : 10/10/2026",
    "STRIPE_KEY=sk_live_SUPERSECRET1",
    "# API_TOKEN exp : 25/10/2026",
    "API_TOKEN=tok-SUPERSECRET2",
    "# OLD_SECRET exp : 01/01/2030",
    "OLD_SECRET=SUPERSECRET3",
    "DB_PASSWORD=SUPERSECRET4",
    "SMTP_PORT=25",
    "# WEIRD_SECRET exp : demain",
    "WEIRD_SECRET=SUPERSECRET5",
  ].join("\n");

  it("sorts keys into expired, expiring, undated and invalid, without any value", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-18T10:00:00Z"), toFake: ["Date"] });
    mockDokploy([project("Shop", "production", [{ id: "a1", name: "api", env }])]);

    const result = await createHandler(tool("env-expiry-report"))({ withinDays: 30 });
    const text = payload(result);
    const data = JSON.parse(text).data;

    expect(data.expired.map((k: { key: string }) => k.key)).toEqual(["STRIPE_KEY"]);
    expect(data.expired[0]).toMatchObject({ project: "Shop", name: "api", daysLeft: -8 });
    expect(data.expiring.map((k: { key: string }) => k.key)).toEqual(["API_TOKEN"]);
    expect(data.expiring[0].daysLeft).toBe(7);
    expect(data.undated.map((k: { key: string }) => k.key)).toEqual(["DB_PASSWORD"]);
    expect(data.invalid.map((k: { key: string }) => k.key)).toEqual(["WEIRD_SECRET"]);
    expect(text).not.toContain("SUPERSECRET");
  });

  it("only flags what falls inside the requested window", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-18T10:00:00Z"), toFake: ["Date"] });
    mockDokploy([project("Shop", "production", [{ id: "a1", name: "api", env }])]);
    const data = JSON.parse(
      payload(await createHandler(tool("env-expiry-report"))({ withinDays: 3 })),
    ).data;
    expect(data.expiring).toEqual([]);
  });
});

describe("application-env-set-expiry", () => {
  it("writes the normed comment above the variable and leaves its value alone", async () => {
    mockDokploy([], { a1: "A=1\nAPI_TOKEN=tok-SUPERSECRET2" });
    const result = await createHandler(tool("application-env-set-expiry"))({
      applicationId: "a1",
      key: "API_TOKEN",
      expires: "5/1/2027",
    });
    expect(post).toHaveBeenCalledWith("/application.update", {
      applicationId: "a1",
      env: "A=1\n# API_TOKEN exp : 05/01/2027\nAPI_TOKEN=tok-SUPERSECRET2",
    });
    expect(payload(result)).not.toContain("SUPERSECRET");
  });

  it("removes the date when none is given", async () => {
    mockDokploy([], { a1: "# K exp : 01/01/2027\nK=v" });
    await createHandler(tool("application-env-set-expiry"))({ applicationId: "a1", key: "K" });
    expect(post).toHaveBeenCalledWith("/application.update", { applicationId: "a1", env: "K=v" });
  });

  it("rejects an invalid date and a missing variable without writing", async () => {
    mockDokploy([], { a1: "K=v" });
    const handler = createHandler(tool("application-env-set-expiry"));
    expect((await handler({ applicationId: "a1", key: "K", expires: "31/02/2027" })).isError).toBe(
      true,
    );
    expect(
      (await handler({ applicationId: "a1", key: "NOPE", expires: "01/01/2027" })).isError,
    ).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

const world = () =>
  mockDokploy(
    [
      project("Vault", "production", [
        { id: "v1", name: "keys", env: "STRIPE_KEY=sk_live_VAULTVALUE\nLABEL=hello" },
      ]),
      project("Shop", "production", [
        { id: "a2", name: "api", env: "PORT=3000" },
        { kind: "compose", id: "c1", name: "worker", env: "OTHER=1" },
      ]),
    ],
    {},
  );

describe("env-copy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("copies a key to several projects under different names, tagging its origin, without leaking it", async () => {
    const logs = captureLogs();
    world();
    const result = await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "STRIPE_KEY",
      targets: [
        { resource: "application", id: "a2", key: "PAYMENT_SECRET" },
        { resource: "compose", id: "c1", key: "STRIPE_API_KEY" },
      ],
    });

    expect(post).toHaveBeenCalledWith("/application.update", {
      applicationId: "a2",
      env: "PORT=3000\n# PAYMENT_SECRET src : Vault/production/keys/STRIPE_KEY\nPAYMENT_SECRET=sk_live_VAULTVALUE",
    });
    expect(post).toHaveBeenCalledWith("/compose.update", {
      composeId: "c1",
      env: "OTHER=1\n# STRIPE_API_KEY src : Vault/production/keys/STRIPE_KEY\nSTRIPE_API_KEY=sk_live_VAULTVALUE",
    });
    const data = JSON.parse(payload(result)).data;
    expect(data.targets.map((t: { status: string }) => t.status)).toEqual(["ok", "ok"]);
    expect(payload(result)).not.toContain("VAULTVALUE");
    expect(logs.join("\n")).not.toContain("VAULTVALUE");
  });

  it("keeps the source name when a target gives none, and copies quoted or multi-line values as is", async () => {
    mockDokploy([
      project("Vault", "production", [
        { id: "v1", name: "keys", env: 'PEM="-----BEGIN\nabc\n-----END"' },
      ]),
      project("Shop", "production", [{ id: "a2", name: "api", env: "" }]),
    ]);
    await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "PEM",
      targets: [{ resource: "application", id: "a2" }],
    });
    expect(post).toHaveBeenCalledWith("/application.update", {
      applicationId: "a2",
      env: '# PEM src : Vault/production/keys/PEM\nPEM="-----BEGIN\nabc\n-----END"',
    });
  });

  it("finds the source by vault project and name, only inside a declared vault", async () => {
    world();
    const handler = createHandler(tool("env-copy"));
    const call = {
      sourceVault: "Vault",
      sourceKey: "STRIPE_KEY",
      targets: [{ resource: "application", id: "a2" }],
    };

    expect((await handler(call)).isError).toBe(true);
    expect(post).not.toHaveBeenCalled();

    vi.stubEnv("DOKPLOY_VAULT_PROJECTS", "Vault");
    expect((await handler(call)).isError).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not write anything when the source variable does not exist", async () => {
    world();
    const result = await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "NOPE",
      targets: [{ resource: "application", id: "a2" }],
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("reports a failing target without cancelling the others", async () => {
    world();
    const result = await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "STRIPE_KEY",
      targets: [
        { resource: "application", id: "ghost" },
        { resource: "application", id: "a2" },
      ],
    });
    const data = JSON.parse(payload(result)).data;
    expect(data.targets.map((t: { status: string }) => t.status)).toEqual(["error", "ok"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: copying again changes nothing", async () => {
    mockDokploy([
      project("Vault", "production", [{ id: "v1", name: "keys", env: "K=v" }]),
      project("Shop", "production", [
        { id: "a2", name: "api", env: "# K src : Vault/production/keys/K\nK=v" },
      ]),
    ]);
    const result = await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "K",
      targets: [{ resource: "application", id: "a2" }],
    });
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(payload(result)).data.targets[0].action).toBe("unchanged");
  });

  it("refuses to copy a variable onto itself", async () => {
    world();
    const result = await createHandler(tool("env-copy"))({
      sourceResource: "application",
      sourceId: "v1",
      sourceKey: "STRIPE_KEY",
      targets: [{ resource: "application", id: "v1" }],
    });
    expect(JSON.parse(payload(result)).data.targets[0].status).toBe("error");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("env-audit-duplicates", () => {
  afterEach(() => vi.unstubAllEnvs());

  const audited = () =>
    mockDokploy([
      project("Vault", "production", [
        {
          id: "v1",
          name: "keys",
          env: "STRIPE_KEY=sk_live_AAAAAAAAAAAAAAAA1234\nUNIQUE_TOKEN=zzzzzzzzzzzzzzzzzzzz9999",
        },
      ]),
      project("Shop", "production", [
        {
          id: "a2",
          name: "api",
          env: "# PAYMENT_SECRET src : Vault/production/keys/STRIPE_KEY\nPAYMENT_SECRET=sk_live_AAAAAAAAAAAAAAAA1234\nAPP_HOST=example.com",
        },
        {
          kind: "compose",
          id: "c1",
          name: "worker",
          env: "OLD_STRIPE=sk_live_AAAAAAAAAAAAAAAA9999\nOTHER_PASSWORD=pw1234\nAPP_HOST=example.com",
        },
        {
          id: "a3",
          name: "admin",
          env: "ADMIN_PASSWORD=pw1234\nEXTRA_KEY=qqqqqqqqqqXXXXXXXXXXrrrrrrrrrr",
        },
      ]),
    ]);

  it("groups secrets that share a prefix, a suffix or the exact value, without exposing any of it", async () => {
    vi.stubEnv("DOKPLOY_VAULT_PROJECTS", "Vault");
    audited();
    const result = await createHandler(tool("env-audit-duplicates"))({});
    const text = payload(result);
    const { groups } = JSON.parse(text).data;

    expect(groups).toHaveLength(2);
    const [stripe, passwords] = groups;
    expect(stripe.usages).toBe(3);
    expect(stripe.matchedBy).toContain("prefix");
    expect(stripe.distinctValues).toBe(2);
    expect(stripe.members.map((m: { key: string }) => m.key).sort()).toEqual([
      "OLD_STRIPE",
      "PAYMENT_SECRET",
      "STRIPE_KEY",
    ]);
    // the vault copy and the tagged copy are tracked, the worker's is an orphan
    expect(stripe.orphans).toBe(1);
    expect(stripe.members.find((m: { key: string }) => m.key === "STRIPE_KEY").inVault).toBe(true);
    expect(stripe.members.find((m: { key: string }) => m.key === "PAYMENT_SECRET").src).toBe(
      "Vault/production/keys/STRIPE_KEY",
    );
    expect(passwords.matchedBy).toEqual(["exact"]);
    expect(passwords.usages).toBe(2);

    expect(text).not.toContain("AAAAAAAAAA");
    expect(text).not.toContain("sk_live");
    expect(text).not.toContain("pw1234");
    expect(text).not.toContain("APP_HOST");
  });

  it("shares a suffix as well as a prefix", async () => {
    mockDokploy([
      project("P", "production", [
        { id: "a1", name: "x", env: "A_TOKEN=aaaaaaaaaa-different-tail-1234567890" },
        { id: "a2", name: "y", env: "B_TOKEN=bbbbbbbbbb-another-tail-xx1234567890" },
      ]),
    ]);
    const { groups } = JSON.parse(
      payload(await createHandler(tool("env-audit-duplicates"))({})),
    ).data;
    expect(groups).toHaveLength(1);
    expect(groups[0].matchedBy).toEqual(["suffix"]);
  });
});
