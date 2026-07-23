import type { AuthProvider, AuthResponse, TokenInfo } from "./types.js";
import type { AnaplanInstanceConfig } from "./instances.js";

const _BASIC_SCHEMA = 0x4c533231;
const AUTH_TIMEOUT_MS = 15000;

export class BasicAuthProvider implements AuthProvider {
  private readonly username: string;
  private readonly password: string;
  private readonly authUrl: string;
  private readonly refreshUrl: string;

  constructor(username: string, password: string, instance: AnaplanInstanceConfig) {
    if (!username) throw new Error("Anaplan username is required");
    if (!password) throw new Error("Anaplan password is required");
    this.username = username;
    this.password = password;
    this.authUrl = `${instance.authBaseUrl}/token/authenticate`;
    this.refreshUrl = `${instance.authBaseUrl}/token/refresh`;
  }

  async authenticate(): Promise<TokenInfo> {
    const authHeader = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    const response = await fetch(this.authUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Authentication request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AuthResponse;
    if (data.status !== "SUCCESS") {
      throw new Error(`Authentication failed: ${data.statusMessage}`);
    }
    return data.tokenInfo;
  }

  async refresh(tokenValue: string): Promise<TokenInfo> {
    const response = await fetch(this.refreshUrl, {
      method: "POST",
      headers: {
        Authorization: `AnaplanAuthToken ${tokenValue}`,
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/json",
        "Accept": "application/json",
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
