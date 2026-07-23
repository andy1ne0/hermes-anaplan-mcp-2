import { describe, it, expect, vi, beforeEach } from "vitest";
import { CertificateAuthProvider } from "./certificate.js";
import { resolveInstanceConfig } from "./instances.js";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

vi.mock("node:fs");
vi.mock("node:crypto");

const US1 = resolveInstanceConfig({});

describe("CertificateAuthProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if cert path or key path is missing", () => {
    expect(() => new CertificateAuthProvider("", "/key.pem", US1)).toThrow("certificate");
    expect(() => new CertificateAuthProvider("/cert.pem", "", US1)).toThrow("private key");
  });

  it("uses v2 certificate payload by default", async () => {
    const fakeCert = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----";
    const fakeKey = "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----";
    const fixedNow = 1_770_900_000_000;

    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (String(path).includes("cert")) return fakeCert;
      return fakeKey;
    });
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    const mockRandomBytes = Buffer.from("a".repeat(100));
    vi.mocked(crypto.randomBytes).mockReturnValue(mockRandomBytes as any);

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(Buffer.from("signed")),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as any);

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "SUCCESS",
        tokenInfo: {
          tokenId: "tid",
          tokenValue: "certtoken",
          expiresAt: Date.now() + 2100000,
          refreshTokenId: "rid",
        },
      }),
    } as Response);

    const provider = new CertificateAuthProvider("/cert.pem", "/key.pem", US1);
    const token = await provider.authenticate();

    expect(token.tokenValue).toBe("certtoken");
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.anaplan.com/token/authenticate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("CACertificate "),
        }),
      })
    );

    const request = vi.mocked(fetch).mock.calls[0][1];
    const body = JSON.parse(String(request?.body));
    expect(body.encodedDataFormat).toBe("v2");

    const decodedData = Buffer.from(body.encodedData, "base64");
    expect(decodedData.length).toBe(108);
    expect(decodedData.readBigUInt64BE(0)).toBe(BigInt(fixedNow));
    expect(decodedData.subarray(8).equals(mockRandomBytes)).toBe(true);
  });

  it("supports legacy v1 certificate payload", async () => {
    const fakeCert = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----";
    const fakeKey = "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----";

    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (String(path).includes("cert")) return fakeCert;
      return fakeKey;
    });

    vi.mocked(crypto.randomBytes).mockReturnValue(Buffer.from("b".repeat(100)) as any);

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(Buffer.from("signed")),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as any);

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "SUCCESS",
        tokenInfo: {
          tokenId: "tid",
          tokenValue: "certtoken",
          expiresAt: Date.now() + 2100000,
          refreshTokenId: "rid",
        },
      }),
    } as Response);

    const provider = new CertificateAuthProvider("/cert.pem", "/key.pem", US1, "v1");
    await provider.authenticate();

    const request = vi.mocked(fetch).mock.calls[0][1];
    const body = JSON.parse(String(request?.body));
    expect(body.encodedDataFormat).toBeUndefined();
    expect(Buffer.from(body.encodedData, "base64").length).toBe(100);
  });
});
