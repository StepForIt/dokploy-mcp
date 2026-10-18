import { describe, expect, it } from "vitest";
import {
  daysUntil,
  formatAnnotation,
  parseAnnotation,
  parseExpiry,
  parseRef,
  refToString,
} from "./envAnnotations.js";

describe("parseAnnotation", () => {
  it("reads an expiry comment", () => {
    expect(parseAnnotation("# TOTO exp : 10/12/2026")).toEqual({
      key: "TOTO",
      tag: "exp",
      value: "10/12/2026",
    });
  });

  it("is tolerant on spaces and case", () => {
    expect(parseAnnotation("   #TOTO   EXP:10/12/2026  ")).toEqual({
      key: "TOTO",
      tag: "exp",
      value: "10/12/2026",
    });
  });

  it("reads a provenance comment", () => {
    expect(parseAnnotation("# PAY src : a/prod/api/STRIPE_KEY")?.tag).toBe("src");
  });

  it("ignores ordinary comments and variables", () => {
    expect(parseAnnotation("# just a note")).toBeNull();
    expect(parseAnnotation("# TOTO foo : bar")).toBeNull();
    expect(parseAnnotation("TOTO=exp : 1")).toBeNull();
    expect(parseAnnotation("")).toBeNull();
  });

  it("round-trips through formatAnnotation", () => {
    expect(formatAnnotation("A_B", "exp", "01/02/2027")).toBe("# A_B exp : 01/02/2027");
    expect(parseAnnotation(formatAnnotation("A_B", "exp", "01/02/2027"))?.value).toBe("01/02/2027");
  });
});

describe("parseExpiry", () => {
  it("parses a real date as UTC midnight", () => {
    expect(parseExpiry("10/12/2026")?.toISOString()).toBe("2026-12-10T00:00:00.000Z");
    expect(parseExpiry("1/2/2027")?.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("rejects impossible or malformed dates", () => {
    for (const bad of ["31/02/2026", "00/01/2026", "10/13/2026", "2026-12-10", "demain", ""]) {
      expect(parseExpiry(bad), bad).toBeNull();
    }
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-10-18T15:30:00Z");
  it("counts whole days, today is 0, past is negative", () => {
    expect(daysUntil(parseExpiry("18/10/2026") as Date, now)).toBe(0);
    expect(daysUntil(parseExpiry("20/10/2026") as Date, now)).toBe(2);
    expect(daysUntil(parseExpiry("17/10/2026") as Date, now)).toBe(-1);
  });
});

describe("provenance refs", () => {
  it("round-trips project/environment/resource/variable", () => {
    const ref = {
      project: "Proj A",
      environment: "production",
      resource: "api",
      key: "STRIPE_KEY",
    };
    expect(refToString(ref)).toBe("Proj A/production/api/STRIPE_KEY");
    expect(parseRef("Proj A/production/api/STRIPE_KEY")).toEqual(ref);
  });

  it("escapes slashes inside names", () => {
    const ref = { project: "a/b", environment: "prod", resource: "x%y", key: "K" };
    expect(parseRef(refToString(ref))).toEqual(ref);
  });

  it("rejects a malformed ref", () => {
    expect(parseRef("only/three/parts")).toBeNull();
    expect(parseRef("a/b/c/not valid")).toBeNull();
  });
});
