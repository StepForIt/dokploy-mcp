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
      key: "SMTP_PORT",
      value: "587",
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
    await createHandler(tool("compose-env-upsert"))({ composeId: "c1", key: "A", value: "1" });
    expect(post).not.toHaveBeenCalled();
  });

  it("never rebuilds the env when the current one cannot be read", async () => {
    get.mockResolvedValue({ data: { composeId: "c1" } });
    const result = await createHandler(tool("compose-env-upsert"))({
      composeId: "c1",
      key: "A",
      value: "1",
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
      key: "NEW_SECRET",
      value: "abc",
    });

    expect(get).toHaveBeenCalledWith("/application.one", { params: { applicationId: "a1" } });
    expect(post).toHaveBeenCalledWith("/application.update", {
      applicationId: "a1",
      env: "NEW_SECRET=abc",
    });
  });

  it("rejects a masked placeholder and multi-line values", () => {
    const { schema } = tool("application-env-upsert");
    expect(schema.safeParse({ applicationId: "a1", key: "K", value: "[REDACTED]" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ applicationId: "a1", key: "K", value: "a\nb" }).success).toBe(false);
    expect(schema.safeParse({ applicationId: "a1", key: "1BAD", value: "x" }).success).toBe(false);
    expect(schema.safeParse({ applicationId: "a1", key: "K", value: "x" }).success).toBe(true);
  });
});
