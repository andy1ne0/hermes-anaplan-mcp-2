import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { AuthProvider, AuthResponse, TokenInfo } from "./types.js";
import type { AnaplanInstanceConfig } from "./instances.js";

const RANDOM_BYTES_LENGTH = 100;
const AUTH_TIMEOUT_MS = 15000;

export type CertificateEncodedDataFormat = "v1" | "v2";

export class CertificateAuthProvider implements AuthProvider {
  private readonly certPath: string;
  private readonly keyPath: string;
  private readonly encodedDataFormat: CertificateEncodedDataFormat;
  private readonly authUrl: string;
  private readonly refreshUrl: string;

  constructor(
    certPath: string,
    keyPath: string,
    instance: AnaplanInstanceConfig,
    encodedDataFormat: CertificateEncodedDataFormat = "v2"
  ) {
    if (!certPath) throw new Error("Anaplan certificate path is required");
    if (!keyPath) throw new Error("Anaplan private key path is required");
    if (encodedDataFormat !== "v1" && encodedDataFormat !== "v2") {
      throw new Error("Certificate encoded data format must be 'v1' or 'v2'");
    }
    this.certPath = certPath;
    this.keyPath = keyPath;
    this.encodedDataFormat = encodedDataFormat;
    this.authUrl = `${instance.authBaseUrl}/token/authenticate`;
    this.refreshUrl = `${instance.authBaseUrl}/token/refresh`;
  }

  async authenticate(): Promise<TokenInfo> {
    const cert = fs.readFileSync(this.certPath, "utf-8");
    const key = fs.readFileSync(this.keyPath, "utf-8");

    const encodedCert = Buffer.from(cert).toString("base64");
    // LS-21: nonce must be >= 64 bytes, using 100 for entropy margin
    const rawData = this.generateEncodedDataBytes();
    const encodedData = rawData.toString("base64");

    const signer = crypto.createSign("SHA512");
    signer.update(rawData);
    signer.end();
    const encodedSignedData = signer.sign(key, "base64");

    const requestBody = this.encodedDataFormat === "v2"
      ? { encodedDataFormat: "v2", encodedData, encodedSignedData }
      : { encodedData, encodedSignedData };

    const response = await fetch(this.authUrl, {
      method: "POST",
      headers: {
        Authorization: `CACertificate ${encodedCert}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Certificate auth request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AuthResponse;
    if (data.status !== "SUCCESS") {
      throw new Error(`Certificate authentication failed: ${data.statusMessage}`);
    }
    return data.tokenInfo;
  }

  private generateEncodedDataBytes(): Buffer {
    if (this.encodedDataFormat === "v1") {
      // v1 payload: random data only (legacy behavior).
      return crypto.randomBytes(RANDOM_BYTES_LENGTH);
    }

    // v2 payload: 8-byte timestamp prefix + random bytes.
    const timestampPrefix = Buffer.alloc(8);
    timestampPrefix.writeBigUInt64BE(BigInt(Date.now()));
    return Buffer.concat([timestampPrefix, crypto.randomBytes(RANDOM_BYTES_LENGTH)]);
  }

  async refresh(tokenValue: string): Promise<TokenInfo> {
    const response = await fetch(this.refreshUrl, {
      method: "POST",
      headers: {
        Authorization: `AnaplanAuthToken ${tokenValue}`,
      },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Token refresh request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AuthResponse;
    if (data.status !== "SUCCESS") {
      throw new Error(`Token refresh failed: ${data.statusMessage}`);
    }
    return data.tokenInfo;
  }
}
