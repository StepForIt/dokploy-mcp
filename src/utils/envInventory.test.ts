import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./apiClient.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const apiClient = (await import("./apiClient.js")).default;
const { getVaultProjects, loadInventory, findByRef } = await import("./envInventory.js");
const get = vi.mocked(apiClient.get);

const projects = [
  {
    projectId: "p1",
    name: "Vault",
    environments: [
      {
        name: "production",
        applications: [{ applicationId: "a1", name: "keys", env: "STRIPE=sk-1" }],
        compose: [],
      },
    ],
  },
  {
    projectId: "p2",
    name: "Shop",
    environments: [
      {
        name: "production",
        applications: [{ applicationId: "a2", name: "api" }],
        compose: [{ composeId: "c1", name: "worker", env: null }],
      },
    ],
  },
];

describe("loadInventory", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("flattens projects/environments/resources and reads missing envs one by one", async () => {
    get.mockImplementation(async (url: string, opts?: { params?: Record<string, string> }) => {
      if (url === "/project.all") return { data: projects };
      if (url === "/application.one")
        return { data: { env: `FROM_ONE=${opts?.params?.applicationId}` } };
      throw new Error(`unexpected ${url}`);
    });
    const { entries, unreadable } = await loadInventory();
    expect(unreadable).toEqual([]);
    expect(entries.map((e) => [e.project, e.environmentName, e.name, e.resource, e.env])).toEqual([
      ["Vault", "production", "keys", "application", "STRIPE=sk-1"],
      ["Shop", "production", "api", "application", "FROM_ONE=a2"],
      ["Shop", "production", "worker", "compose", null],
    ]);
  });

  it("supports the older shape without environments", async () => {
    get.mockResolvedValueOnce({
      data: [
        {
          projectId: "p",
          name: "Old",
          applications: [{ applicationId: "a", name: "x", env: "K=1" }],
        },
      ],
    });
    const { entries } = await loadInventory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ project: "Old", environmentName: "default", id: "a" });
  });

  it("reports a resource it cannot read instead of failing the whole scan", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === "/project.all") return { data: projects };
      throw new Error("boom with SECRET=abc");
    });
    const { entries, unreadable } = await loadInventory();
    expect(entries.map((e) => e.id)).toEqual(["a1", "c1"]);
    expect(unreadable).toEqual([
      {
        resource: "application",
        id: "a2",
        name: "api",
        project: "Shop",
        environmentName: "production",
      },
    ]);
    expect(JSON.stringify(unreadable)).not.toContain("abc");
  });
});

describe("findByRef", () => {
  const entries = [
    {
      resource: "application",
      id: "a1",
      name: "keys",
      projectId: "p1",
      project: "Vault",
      environmentName: "production",
      env: "",
    },
    {
      resource: "application",
      id: "a9",
      name: "keys",
      projectId: "p1",
      project: "Vault",
      environmentName: "staging",
      env: "",
    },
  ] as const;

  it("resolves a ref by names, environment included", () => {
    expect(
      findByRef([...entries], {
        project: "Vault",
        environment: "staging",
        resource: "keys",
        key: "K",
      }),
    ).toEqual({ found: entries[1] });
  });

  it("says why it cannot resolve", () => {
    expect(
      findByRef([...entries], {
        project: "Vault",
        environment: "nope",
        resource: "keys",
        key: "K",
      }),
    ).toEqual({ error: "not-found" });
    expect(
      findByRef([...entries, { ...entries[0], id: "a2" }], {
        project: "Vault",
        environment: "production",
        resource: "keys",
        key: "K",
      }),
    ).toEqual({ error: "ambiguous" });
  });
});

describe("getVaultProjects", () => {
  it("reads the comma-separated list, trimmed", () => {
    vi.stubEnv("DOKPLOY_VAULT_PROJECTS", " Vault , Secrets ,,");
    expect(getVaultProjects()).toEqual(["Vault", "Secrets"]);
    vi.unstubAllEnvs();
    expect(getVaultProjects()).toEqual([]);
  });
});
