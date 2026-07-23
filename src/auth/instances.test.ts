import { describe, it, expect } from "vitest";
import { resolveInstanceConfig } from "./instances.js";

describe("resolveInstanceConfig", () => {
  it("defaults to us1 when ANAPLAN_INSTANCE is not set", () => {
    const config = resolveInstanceConfig({});
    expect(config.id).toBe("us1");
    expect(config.authBaseUrl).toBe("https://auth.anaplan.com");
    expect(config.apiBaseUrl).toBe("https://api.anaplan.com");
    expect(config.oauthBaseUrl).toBe("https://us1a.app.anaplan.com");
  });

  it("resolves us1 explicitly", () => {
    const config = resolveInstanceConfig({ ANAPLAN_INSTANCE: "us1" });
    expect(config.authBaseUrl).toBe("https://auth.anaplan.com");
    expect(config.apiBaseUrl).toBe("https://api.anaplan.com");
    expect(config.oauthBaseUrl).toBe("https://us1a.app.anaplan.com");
  });

  it("resolves au1", () => {
    const config = resolveInstanceConfig({ ANAPLAN_INSTANCE: "au1" });
    expect(config.id).toBe("au1");
    expect(config.authBaseUrl).toBe("https://auth.anaplan.com");
    expect(config.apiBaseUrl).toBe("https://api.anaplan.com");
    expect(config.oauthBaseUrl).toBe("https://au1a.app2.anaplan.com");
  });

  it("is case-insensitive", () => {
    const config = resolveInstanceConfig({ ANAPLAN_INSTANCE: "AU1" });
    expect(config.id).toBe("au1");
  });

  it("supports a custom instance when all override URLs are set", () => {
    const config = resolveInstanceConfig({
      ANAPLAN_INSTANCE: "eu1",
      ANAPLAN_INSTANCE_AUTH_BASE_URL: "https://auth.anaplan.com",
      ANAPLAN_INSTANCE_API_BASE_URL: "https://api.anaplan.com",
      ANAPLAN_INSTANCE_OAUTH_BASE_URL: "https://eu1a.app.anaplan.com",
    });
    expect(config.id).toBe("eu1");
    expect(config.authBaseUrl).toBe("https://auth.anaplan.com");
    expect(config.apiBaseUrl).toBe("https://api.anaplan.com");
    expect(config.oauthBaseUrl).toBe("https://eu1a.app.anaplan.com");
  });

  it("falls back to the auth override for oauth when no explicit oauth override is given", () => {
    const config = resolveInstanceConfig({
      ANAPLAN_INSTANCE: "eu1",
      ANAPLAN_INSTANCE_AUTH_BASE_URL: "https://eu1a.app.anaplan.com",
      ANAPLAN_INSTANCE_API_BASE_URL: "https://api.anaplan.com",
    });
    expect(config.oauthBaseUrl).toBe("https://eu1a.app.anaplan.com");
  });

  it("throws a clear error for an unknown instance without overrides", () => {
    expect(() => resolveInstanceConfig({ ANAPLAN_INSTANCE: "eu1" })).toThrow(/Unknown Anaplan instance "eu1"/);
  });
});
