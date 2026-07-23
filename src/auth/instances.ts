export interface AnaplanInstanceConfig {
  id: string;
  // Basic/certificate auth (token/authenticate, token/refresh) - global across all instances.
  authBaseUrl: string;
  // Transactional/bulk API - global across all instances.
  apiBaseUrl: string;
  // OAuth2 device grant (device/code, token) - instance-specific host.
  oauthBaseUrl: string;
}

// Registry of known Anaplan instances. Add new instances here as they're needed.
const INSTANCES: Record<string, AnaplanInstanceConfig> = {
  us1: {
    id: "us1",
    authBaseUrl: "https://auth.anaplan.com",
    apiBaseUrl: "https://api.anaplan.com",
    oauthBaseUrl: "https://us1a.app.anaplan.com",
  },
  au1: {
    id: "au1",
    authBaseUrl: "https://auth.anaplan.com",
    apiBaseUrl: "https://api.anaplan.com",
    oauthBaseUrl: "https://au1a.app2.anaplan.com",
  },
};

const DEFAULT_INSTANCE_ID = "us1";

export function resolveInstanceConfig(env: NodeJS.ProcessEnv = process.env): AnaplanInstanceConfig {
  const requested = env.ANAPLAN_INSTANCE?.trim().toLowerCase();

  if (!requested) {
    return INSTANCES[DEFAULT_INSTANCE_ID];
  }

  const known = INSTANCES[requested];
  if (known) {
    return known;
  }

  const customAuthBase = env.ANAPLAN_INSTANCE_AUTH_BASE_URL?.trim();
  const customApiBase = env.ANAPLAN_INSTANCE_API_BASE_URL?.trim();
  const customOAuthBase = env.ANAPLAN_INSTANCE_OAUTH_BASE_URL?.trim() ?? customAuthBase;
  if (customAuthBase && customApiBase && customOAuthBase) {
    return { id: requested, authBaseUrl: customAuthBase, apiBaseUrl: customApiBase, oauthBaseUrl: customOAuthBase };
  }

  throw new Error(
    `Unknown Anaplan instance "${requested}". Supported instances: ${Object.keys(INSTANCES).join(", ")}. ` +
    `To use a different instance, set ANAPLAN_INSTANCE_AUTH_BASE_URL, ANAPLAN_INSTANCE_API_BASE_URL, ` +
    `and ANAPLAN_INSTANCE_OAUTH_BASE_URL.`
  );
}
