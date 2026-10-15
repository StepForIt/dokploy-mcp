import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTED_FIELDS, maskDotenv, redactSensitive } from "./redactSensitive.js";

const R = "[REDACTED]";

describe("maskDotenv", () => {
  it("keeps keys, masks values, keeps comments, blanks and empty values", () => {
    const input = '# Google\nGOOGLE_CLIENT_ID=abc\n\nexport AI_KEY = "sk-1"\nEMPTY=\nnot a pair';
    expect(maskDotenv(input)).toBe(
      `# Google\nGOOGLE_CLIENT_ID=${R}\n\nexport AI_KEY =${R}\nEMPTY=\n${R}`,
    );
  });
});

describe("redactSensitive", () => {
  const compose = {
    name: "dokploy-mcp",
    env: "DOKPLOY_URL=http://x:3000\nDOKPLOY_API_KEY=supersecret",
    composeFile: "services: {}",
    refreshToken: "tok",
    environment: {
      name: "production",
      env: "SHARED=1",
      project: { name: "MCPs", env: "GITHUB=ghp_x" },
    },
    domains: [{ host: "a.example.com", port: 3000 }],
  };

  const out = redactSensitive(compose, DEFAULT_REDACTED_FIELDS);

  it("masks dotenv values but keeps the variable names", () => {
    expect(out.env).toBe(`DOKPLOY_URL=${R}\nDOKPLOY_API_KEY=${R}`);
    expect(JSON.stringify(out)).not.toContain("supersecret");
  });

  it("hides opaque secrets entirely", () => {
    expect(out.composeFile).toBe(R);
    expect(out.refreshToken).toBe(R);
  });

  it("walks into the environment object instead of hiding it", () => {
    expect(out.environment.name).toBe("production");
    expect(out.environment.env).toBe(`SHARED=${R}`);
    expect(out.environment.project.env).toBe(`GITHUB=${R}`);
    expect(JSON.stringify(out)).not.toContain("ghp_x");
  });

  it("leaves non-sensitive data untouched", () => {
    expect(out.name).toBe("dokploy-mcp");
    expect(out.domains).toEqual([{ host: "a.example.com", port: 3000 }]);
  });
});
