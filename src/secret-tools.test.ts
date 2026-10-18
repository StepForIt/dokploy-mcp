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
function mockDokploy(projects: unknown[], envs: Record<string, string | null> = {}) {
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
