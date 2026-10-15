import { describe, expect, it } from "vitest";
import { isAuthorized, readAuthToken } from "./httpAuth.js";

const TOKEN = "a".repeat(40);

describe("readAuthToken", () => {
  it("refuses to start without a token", () => {
    expect(() => readAuthToken({})).toThrow(/MCP_AUTH_TOKEN is required/);
  });

  it("refuses a short token", () => {
    expect(() => readAuthToken({ MCP_AUTH_TOKEN: "short" })).toThrow(/at least 32/);
  });

  it("returns the token", () => {
    expect(readAuthToken({ MCP_AUTH_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
  });

  it("allows an explicit opt-out", () => {
    expect(readAuthToken({ MCP_ALLOW_UNAUTHENTICATED: "true" })).toBeNull();
  });
});

describe("isAuthorized", () => {
  it("accepts a bearer header", () => {
    expect(isAuthorized(TOKEN, `Bearer ${TOKEN}`, undefined)).toBe(true);
  });

  it("accepts a token query parameter", () => {
    expect(isAuthorized(TOKEN, undefined, TOKEN)).toBe(true);
  });

  it("rejects a missing or wrong token", () => {
    expect(isAuthorized(TOKEN, undefined, undefined)).toBe(false);
    expect(isAuthorized(TOKEN, "Bearer nope", undefined)).toBe(false);
    expect(isAuthorized(TOKEN, undefined, `${TOKEN}x`)).toBe(false);
  });
});
