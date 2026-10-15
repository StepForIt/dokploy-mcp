import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTED_FIELDS, maskDotenv, redactSensitive } from "./redactSensitive.js";

const R = "[REDACTED]";

describe("maskDotenv", () => {
  it("masks secret-named values, keeps the rest readable", () => {
    const input = [
      "# Supabase",
      "APP_HOST=cartoflux.example.com",
      "POSTGRES_PASSWORD=pg-real",
      "JWT_SECRET=jwt-real",
      "SERVICE_ROLE_KEY=role-real",
      "ADMIN_EMAILS=a@example.com",
      "GOOGLE_AUTH_ENABLED=true",
      "GOOGLE_CLIENT_SECRET=GOCSPX-real",
      "SMTP_HOST=smtp.gmail.com",
      "SMTP_PORT=587",
      "SMTP_USER=me@example.com",
      "SMTP_PASS=gmail-real",
      "NPM_AUTH=npm-real",
      "EMPTY_TOKEN=",
      "",
      "not a pair",
    ].join("\n");
    expect(maskDotenv(input)).toBe(
      [
        "# Supabase",
        "APP_HOST=cartoflux.example.com",
        `POSTGRES_PASSWORD=${R}`,
        `JWT_SECRET=${R}`,
        `SERVICE_ROLE_KEY=${R}`,
        "ADMIN_EMAILS=a@example.com",
        "GOOGLE_AUTH_ENABLED=true",
        `GOOGLE_CLIENT_SECRET=${R}`,
        "SMTP_HOST=smtp.gmail.com",
        "SMTP_PORT=587",
        `SMTP_USER=${R}`,
        `SMTP_PASS=${R}`,
        `NPM_AUTH=${R}`,
        "EMPTY_TOKEN=",
        "",
        R,
      ].join("\n"),
    );
  });

  it("catches secret words glued in the name, not look-alikes", () => {
    expect(
      maskDotenv("DBPASSWORD=a\nAPISECRET=b\nKEYBOARD_LAYOUT=fr\nNEXTAUTH_URL=https://x.io"),
    ).toBe(`DBPASSWORD=${R}\nAPISECRET=${R}\nKEYBOARD_LAYOUT=fr\nNEXTAUTH_URL=https://x.io`);
  });

  it("masks known secret formats whatever the name", () => {
    expect(maskDotenv("ACCESS=ghp_abc\nOPENAI=sk-abc\nANON=eyJhbGciOiJIUzI1NiJ9.x.y")).toBe(
      `ACCESS=${R}\nOPENAI=${R}\nANON=${R}`,
    );
  });

  it("masks only the credentials inside a URL", () => {
    expect(
      maskDotenv("DATABASE_URL=postgres://app:pw@db:5432/app\nSENTRY_URL=https://k@o1.ingest.io/2"),
    ).toBe(`DATABASE_URL=postgres://${R}@db:5432/app\nSENTRY_URL=https://${R}@o1.ingest.io/2`);
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
      env: "SHARED_SECRET=s1",
      project: { name: "MCPs", env: "GITHUB=ghp_x" },
    },
    domains: [{ host: "a.example.com", port: 3000 }],
  };

  const out = redactSensitive(compose, DEFAULT_REDACTED_FIELDS);

  it("masks secret values but keeps the variable names", () => {
    expect(out.env).toBe(`DOKPLOY_URL=http://x:3000\nDOKPLOY_API_KEY=${R}`);
    expect(JSON.stringify(out)).not.toContain("supersecret");
  });

  it("hides opaque secrets entirely", () => {
    expect(out.composeFile).toBe(R);
    expect(out.refreshToken).toBe(R);
  });

  it("walks into the environment object instead of hiding it", () => {
    expect(out.environment.name).toBe("production");
    expect(out.environment.env).toBe(`SHARED_SECRET=${R}`);
    expect(out.environment.project.env).toBe(`GITHUB=${R}`);
    expect(JSON.stringify(out)).not.toContain("ghp_x");
  });

  it("leaves non-sensitive data untouched", () => {
    expect(out.name).toBe("dokploy-mcp");
    expect(out.domains).toEqual([{ host: "a.example.com", port: 3000 }]);
  });
});
