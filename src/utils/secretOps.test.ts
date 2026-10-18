import { describe, expect, it, vi } from "vitest";

vi.mock("./apiClient.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const { generateSecret } = await import("./secretOps.js");

describe("generateSecret", () => {
  it("honours length and format", () => {
    expect(generateSecret(32, "hex")).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSecret(40, "alphanumeric")).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(generateSecret(44, "base64")).toMatch(/^[A-Za-z0-9+/]{44}$/);
  });

  it("does not repeat", () => {
    expect(generateSecret(48, "alphanumeric")).not.toBe(generateSecret(48, "alphanumeric"));
  });
});
