import { describe, expect, it } from "vitest";
import { upsertEnvVar } from "./upsertEnv.js";

describe("upsertEnvVar", () => {
  it("updates an existing variable in place and keeps every other line", () => {
    const env = "# smtp\nSMTP_HOST=mail.example.com\nSMTP_PASS=s3cr3t\nSMTP_PORT=25";
    expect(upsertEnvVar(env, "SMTP_PORT", "587")).toEqual({
      env: "# smtp\nSMTP_HOST=mail.example.com\nSMTP_PASS=s3cr3t\nSMTP_PORT=587",
      action: "updated",
    });
  });

  it("appends an unknown variable", () => {
    expect(upsertEnvVar("A=1\nB=2\n\n", "C", "3")).toEqual({
      env: "A=1\nB=2\nC=3",
      action: "created",
    });
  });

  it("creates the env from scratch", () => {
    expect(upsertEnvVar(null, "A", "1")).toEqual({ env: "A=1", action: "created" });
    expect(upsertEnvVar("", "A", "1")).toEqual({ env: "A=1", action: "created" });
  });

  it("reports unchanged when the value is already set", () => {
    expect(upsertEnvVar("A=1\nB=2", "A", "1")).toEqual({ env: "A=1\nB=2", action: "unchanged" });
  });

  it("keeps the export prefix", () => {
    expect(upsertEnvVar("export A=1", "A", "2").env).toBe("export A=2");
  });

  it("matches the exact name only", () => {
    expect(upsertEnvVar("API_KEY=x\nKEY=y", "KEY", "z").env).toBe("API_KEY=x\nKEY=z");
  });

  it("drops later duplicates so the new value wins", () => {
    expect(upsertEnvVar("A=1\nB=2\nA=3", "A", "9")).toEqual({ env: "A=9\nB=2", action: "updated" });
  });

  it("replaces a multi-line quoted value as a whole", () => {
    const env = 'KEY="-----BEGIN KEY-----\nMIIEvQ==\n-----END KEY-----"\nNEXT=1';
    expect(upsertEnvVar(env, "KEY", "new").env).toBe("KEY=new\nNEXT=1");
  });

  it("does not touch a multi-line value when updating another variable", () => {
    const env = 'KEY="line1\nOTHER=fake\nline3"\nOTHER=1';
    expect(upsertEnvVar(env, "OTHER", "2").env).toBe('KEY="line1\nOTHER=fake\nline3"\nOTHER=2');
  });
});
