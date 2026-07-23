import { describe, it, expect, vi, beforeEach } from "vitest";
import { BasicAuthProvider } from "./basic.js";
import { resolveInstanceConfig } from "./instances.js";

const US1 = resolveInstanceConfig({});

describe("BasicAuthProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if username or password is missing", () => {
    expect(() => new BasicAuthProvider("", "pass", US1)).toThrow("username");
    expect(() => new BasicAuthProvider("user", "", US1)).toThrow("password");
  });

  it("sends POST to auth endpoint with basic auth header", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        status: "SUCCESS",
        tokenInfo: {
          tokenId: "tid",
          tokenValue: "tval",
          expiresAt: Date.now() + 2100000,
          refreshTokenId: "rid",
        },
      }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

    const provider = new BasicAuthProvider("user@co.com", "secret", US1);
    const token = await provider.authenticate();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://auth.anaplan.com/token/authenticate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Basic "),
        }),
      })
    );
    expect(token.tokenValue).toBe("tval");
  });

  it("throws on non-SUCCESS response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "FAILURE", statusMessage: "Bad creds" }),
    } as Response);

    const provider = new BasicAuthProvider("user", "wrong", US1);
    await expect(provider.authenticate()).rejects.toThrow("Bad creds");
  });

  it("refreshes token with AnaplanAuthToken header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "SUCCESS",
        tokenInfo: {
          tokenId: "tid2",
          tokenValue: "refreshed",
          expiresAt: Date.now() + 2100000,
          refreshTokenId: "rid2",
        },
      }),
    } as Response);

    const provider = new BasicAuthProvider("user", "pass", US1);
    const token = await provider.refresh("oldtoken");

    expect(fetch).toHaveBeenCalledWith(
      "https://auth.anaplan.com/token/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "AnaplanAuthToken oldtoken",
        }),
      })
    );
    expect(token.tokenValue).toBe("refreshed");
  });
});
