import { describe, expect, it } from "vitest";
import {
  readAnnotations,
  readEnvVars,
  setEnvAnnotation,
  unsetEnvVar,
  upsertEnvVar,
} from "./upsertEnv.js";

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

describe("unsetEnvVar", () => {
  it("removes the variable and keeps every other line", () => {
    expect(unsetEnvVar("# db\nDB_PASSWORD=s3cr3t\nOLD_FLAG=1\nPORT=80", "OLD_FLAG")).toEqual({
      env: "# db\nDB_PASSWORD=s3cr3t\nPORT=80",
      action: "removed",
    });
  });

  it("removes every duplicate and a multi-line value as a whole", () => {
    const env = 'A=1\nKEY="line1\nline2"\nB=2\nKEY=again';
    expect(unsetEnvVar(env, "KEY").env).toBe("A=1\nB=2");
  });

  it("matches the exact name only", () => {
    expect(unsetEnvVar("API_KEY=x\nKEY=y", "KEY").env).toBe("API_KEY=x");
  });

  it("reports absent and changes nothing when the variable is missing", () => {
    expect(unsetEnvVar("A=1\n", "B")).toEqual({ env: "A=1\n", action: "absent" });
    expect(unsetEnvVar(null, "B")).toEqual({ env: "", action: "absent" });
  });
});

describe("env annotations", () => {
  const env = "A=1\n# TOKEN exp : 10/12/2026\nTOKEN=abc\nB=2";

  it("reads the expiry and provenance of each variable", () => {
    const withSrc = `${env}\n# B src : p/e/r/K\n`;
    expect(readAnnotations(withSrc).get("TOKEN")).toEqual({ exp: "10/12/2026" });
    expect(readAnnotations(withSrc).get("B")).toEqual({ src: "p/e/r/K" });
  });

  it("inserts a new annotation right above the variable", () => {
    expect(setEnvAnnotation("A=1\nB=2", "B", "exp", "01/01/2027")).toEqual({
      env: "A=1\n# B exp : 01/01/2027\nB=2",
      action: "set",
    });
  });

  it("updates an existing annotation in place and reports unchanged", () => {
    expect(setEnvAnnotation(env, "TOKEN", "exp", "11/12/2026").env).toBe(
      "A=1\n# TOKEN exp : 11/12/2026\nTOKEN=abc\nB=2",
    );
    expect(setEnvAnnotation(env, "TOKEN", "exp", "10/12/2026").action).toBe("unchanged");
  });

  it("removes an annotation with null", () => {
    expect(setEnvAnnotation(env, "TOKEN", "exp", null)).toEqual({
      env: "A=1\nTOKEN=abc\nB=2",
      action: "removed",
    });
  });

  it("never touches the value or other lines, multi-line values included", () => {
    const pem = 'KEY="-----BEGIN\nabc\n-----END"\nOTHER=1';
    expect(setEnvAnnotation(pem, "KEY", "exp", "01/01/2027").env).toBe(
      '# KEY exp : 01/01/2027\nKEY="-----BEGIN\nabc\n-----END"\nOTHER=1',
    );
  });

  it("refuses to annotate a missing variable", () => {
    expect(() => setEnvAnnotation("A=1", "NOPE", "exp", "01/01/2027")).toThrow(/NOPE/);
  });

  it("exposes the raw value of the first definition, quotes and lines kept", () => {
    expect(readEnvVars('A="x y"\nA=2\nP="l1\nl2"').map((v) => [v.name, v.raw])).toEqual([
      ["A", '"x y"'],
      ["P", '"l1\nl2"'],
    ]);
  });

  it("drops a variable's annotations when it is unset", () => {
    expect(unsetEnvVar(env, "TOKEN").env).toBe("A=1\nB=2");
    expect(unsetEnvVar("# NOTE: keep\nA=1", "A").env).toBe("# NOTE: keep");
  });
});
