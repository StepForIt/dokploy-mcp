import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./utils/apiClient.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("./utils/clientConfig.js", async () => {
  const { DEFAULT_REDACTED_FIELDS } = await import("./utils/redactSensitive.js");
  return { getClientConfig: () => ({ redactEnv: true, redactFields: DEFAULT_REDACTED_FIELDS }) };
});

const apiClient = (await import("./utils/apiClient.js")).default;
const { customTools } = await import("./custom-tools.js");
const { createHandler } = await import("./handler.js");

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);

function tool(name: string) {
  const found = customTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function payload(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("compose-env-upsert", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("rewrites one variable, keeps the secrets in clear on Dokploy, masks them in the reply", async () => {
    get.mockResolvedValue({ data: { composeId: "c1", env: "DB_PASSWORD=hunter2\nSMTP_PORT=25" } });
    post.mockResolvedValue({ data: true });

    const result = await createHandler(tool("compose-env-upsert"))({
      composeId: "c1",
      variables: { SMTP_PORT: "587" },
    });

    expect(get).toHaveBeenCalledWith("/compose.one", { params: { composeId: "c1" } });
    expect(post).toHaveBeenCalledWith("/compose.update", {
      composeId: "c1",
      env: "DB_PASSWORD=hunter2\nSMTP_PORT=587",
    });
    const text = payload(result);
    expect(text).toContain("SMTP_PORT=587");
    expect(text).toContain("DB_PASSWORD=[REDACTED]");
    expect(text).not.toContain("hunter2");
  });

  it("does not write when the value is already set", async () => {
    get.mockResolvedValue({ data: { env: "A=1" } });
    await createHandler(tool("compose-env-upsert"))({ composeId: "c1", variables: { A: "1" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("never rebuilds the env when the current one cannot be read", async () => {
    get.mockResolvedValue({ data: { composeId: "c1" } });
    const result = await createHandler(tool("compose-env-upsert"))({
      composeId: "c1",
      variables: { A: "1" },
    });
    expect(post).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});

describe("application-env-upsert", () => {
  it("targets the application endpoints", async () => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: { env: null } });
    post.mockResolvedValue({ data: true });

    await createHandler(tool("application-env-upsert"))({
      applicationId: "a1",
      variables: { NEW_SECRET: "abc" },
    });

    expect(get).toHaveBeenCalledWith("/application.one", { params: { applicationId: "a1" } });
    expect(post).toHaveBeenCalledWith("/application.update", {
      applicationId: "a1",
      env: "NEW_SECRET=abc",
    });
  });

  it("rejects a masked placeholder, multi-line values, bad names and empty input", () => {
    const { schema } = tool("application-env-upsert");
    const ok = (variables: unknown) => schema.safeParse({ applicationId: "a1", variables }).success;
    expect(ok({ K: "[REDACTED]" })).toBe(false);
    expect(ok({ K: "a\nb" })).toBe(false);
    expect(ok({ "1BAD": "x" })).toBe(false);
    expect(ok({})).toBe(false);
    expect(ok({ K: "x", L: "y" })).toBe(true);
    const unset = tool("application-env-unset").schema;
    expect(unset.safeParse({ applicationId: "a1", keys: [] }).success).toBe(false);
  });
});

describe("compose-env-unset", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("removes one variable, keeps the secrets in clear on Dokploy, masks them in the reply", async () => {
    get.mockResolvedValue({ data: { env: "DB_PASSWORD=hunter2\nOLD_FLAG=1" } });
    post.mockResolvedValue({ data: true });

    const result = await createHandler(tool("compose-env-unset"))({
      composeId: "c1",
      keys: ["OLD_FLAG"],
    });

    expect(post).toHaveBeenCalledWith("/compose.update", {
      composeId: "c1",
      env: "DB_PASSWORD=hunter2",
    });
    const text = payload(result);
    expect(text).toContain('"removed"');
    expect(text).not.toContain("hunter2");
  });

  it("does not write when the variable is absent", async () => {
    get.mockResolvedValue({ data: { env: "A=1" } });
    await createHandler(tool("compose-env-unset"))({ composeId: "c1", keys: ["B"] });
    expect(post).not.toHaveBeenCalled();
  });

  it("never rewrites the env when the current one cannot be read", async () => {
    get.mockResolvedValue({ data: {} });
    const result = await createHandler(tool("application-env-unset"))({
      applicationId: "a1",
      keys: ["A"],
    });
    expect(get).toHaveBeenCalledWith("/application.one", { params: { applicationId: "a1" } });
    expect(post).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});

describe("several variables in one call", () => {
  it("sets several variables with a single write", async () => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: { env: "DB_PASSWORD=hunter2\nA=1" } });
    post.mockResolvedValue({ data: true });

    const result = await createHandler(tool("compose-env-upsert"))({
      composeId: "c1",
      variables: { A: "1", B: "2", C: "3" },
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/compose.update", {
      composeId: "c1",
      env: "DB_PASSWORD=hunter2\nA=1\nB=2\nC=3",
    });
    const text = payload(result);
    expect(text).toContain('"A": "unchanged"');
    expect(text).toContain('"B": "created"');
  });

  it("removes several variables with a single write", async () => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: { env: "A=1\nB=2\nC=3" } });
    post.mockResolvedValue({ data: true });

    await createHandler(tool("compose-env-unset"))({ composeId: "c1", keys: ["A", "C", "Z"] });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/compose.update", { composeId: "c1", env: "B=2" });
  });
});
