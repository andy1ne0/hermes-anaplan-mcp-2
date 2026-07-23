#!/usr/bin/env node
/**
 * Anaplan UI automation via Playwright.
 *
 * Handles operations that the Transactional API v2.0 doesn't support:
 * - set_modelmode (ARCHIVED, LOCKED, PRODUCTION, etc.)
 * - create_list (structural creation returns 405 on some tenants)
 * - create_module (structural creation returns 405 on some tenants)
 *
 * Architecture: lazy browser lifecycle. Browser launches on first use,
 * authenticates, and stays alive for subsequent calls. After a configurable
 * idle timeout (default 5 min) the browser closes gracefully.
 *
 * MFA: if running headless and MFA is required, throws with a clear error.
 * Set ANAPLAN_PLAYWRIGHT_HEADLESS=false for interactive MFA entry.
 *
 * Enable/disable: set ANAPLAN_PLAYWRIGHT_ENABLED=true (default: false).
 * When disabled, all methods return a user-friendly error guiding manual UI action.
 *
 * Region: defaults to "au1". Override with ANAPLAN_REGION.
 * Credentials: reads ANAPLAN_USERNAME and ANAPLAN_PASSWORD from env.
 */
import type { Browser, BrowserContext, Page } from "playwright";

// Region → base URL mapping (matches client.ts regions)
const REGION_BASE_URLS: Record<string, string> = {
  au1: "https://au1a.app2.anaplan.com",
  us1: "https://us1a.app2.anaplan.com",
  us2: "https://us2a.app2.anaplan.com",
  eu1: "https://eu1a.app2.anaplan.com",
  default: "https://au1a.app2.anaplan.com",
};

export type ModelMode = "UNLOCKED" | "LOCKED" | "ARCHIVED" | "PRODUCTION" | "PRODUCTION_MAINTENANCE";

export interface UIResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface AnaplanUIOptions {
  username: string;
  password: string;
  region?: string;
  headless?: boolean;
  idleTimeoutMs?: number;
  enabled?: boolean;
}

export class AnaplanUI {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly opts: Required<AnaplanUIOptions>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;
  /** Whether Playwright UI automation is enabled */
  public readonly enabled: boolean;

  constructor(opts: AnaplanUIOptions) {
    this.opts = {
      username: opts.username,
      password: opts.password,
      region: opts.region ?? process.env.ANAPLAN_REGION ?? "au1",
      headless: opts.headless ?? (process.env.ANAPLAN_PLAYWRIGHT_HEADLESS !== "false"),
      idleTimeoutMs: opts.idleTimeoutMs ?? 5 * 60 * 1000,
      enabled: opts.enabled ?? (process.env.ANAPLAN_PLAYWRIGHT_ENABLED === "true"),
    };
    this.enabled = this.opts.enabled;
  }

  /**
   * Create a disabled AnaplanUI instance (used when Playwright is not configured).
   * All methods will return guidance messages instead of attempting UI automation.
   */
  static disabled(): AnaplanUI {
    return new AnaplanUI({ username: "", password: "", enabled: false });
  }

  /** Create from environment variables (ANAPLAN_PLAYWRIGHT_*) */
  static fromEnv(): AnaplanUI {
    const region = process.env.ANAPLAN_PLAYWRIGHT_REGION || "au1a";
    const baseUrls: Record<string, string> = { ...REGION_BASE_URLS };
    return new AnaplanUI({
      username: process.env.ANAPLAN_USERNAME || "",
      password: process.env.ANAPLAN_PASSWORD || "",
      enabled: true,
      region,
      headless: process.env.ANAPLAN_PLAYWRIGHT_HEADLESS !== "false",
    });
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Change model mode via Anaplan UI.
   * Flow: Home → Model Management → select model → Change Mode → pick mode → OK
   */
  async setModelMode(
    workspaceId: string,
    modelId: string,
    mode: ModelMode,
  ): Promise<UIResult> {
    if (!this.enabled) {
      return this.disabledMessage("change model mode", mode);
    }
    const page = await this.getAuthenticatedPage();
    try {
      const base = REGION_BASE_URLS[this.opts.region] ?? REGION_BASE_URLS.default;

      // Navigate to workspace model management
      await page.goto(base + "/home?scopeId=" + workspaceId, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // Click "Model Management" in left nav
      const modelMgmt = page.locator("text=Model Management").first();
      await modelMgmt.waitFor({ state: "visible", timeout: 10000 });
      await modelMgmt.click();
      await page.waitForTimeout(2000);

      // Find and select model row by ID
      const modelRow = page.locator("tr").filter({ hasText: modelId }).first();
      await modelRow.waitFor({ state: "visible", timeout: 10000 });
      const checkbox = modelRow.locator('input[type="checkbox"]').first();
      await checkbox.check();

      // Click "Change Mode" button
      const changeModeBtn = page.locator("text=Change Mode").first();
      await changeModeBtn.waitFor({ state: "visible", timeout: 5000 });
      await changeModeBtn.click();

      // Select target mode
      const modeRadio = page.locator('input[type="radio"][value="' + mode + '"]').first();
      const modeLabel = page.locator("label").filter({ hasText: mode }).first();
      if (await modeRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
        await modeRadio.check();
      } else {
        await modeLabel.click();
      }

      // Confirm
      const okBtn = page.locator("text=OK").first().or(page.locator("text=Confirm").first());
      await okBtn.click();
      await page.waitForTimeout(3000);

      this.resetIdleTimer();
      return { success: true, message: "Model mode changed to " + mode + " via Anaplan UI." };
    } catch (err: any) {
      return {
        success: false,
        message: "UI automation failed: " + (err?.message ?? String(err)) +
          ". Use Anaplan UI manually: Model Management → select model → Change Mode → " + mode + ".",
      };
    }
  }

  /**
   * Create a list via Anaplan UI.
   * Flow: Open model → Settings → Lists → Add List → fill name → Save
   */
  async createList(
    workspaceId: string,
    modelId: string,
    name: string,
    description?: string,
  ): Promise<UIResult> {
    if (!this.enabled) {
      return this.disabledMessage("create list", name);
    }
    const page = await this.getAuthenticatedPage();
    try {
      const base = REGION_BASE_URLS[this.opts.region] ?? REGION_BASE_URLS.default;

      // Navigate directly to model (Anaplan SPA)
      // URL format: {base}/models/{modelId}
      await page.goto(base + "/models/" + modelId, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.waitForTimeout(5000);

      // Wait for model to fully load (SPA takes time)
      // Look for the main nav — either "Settings" tab or "Modules" tab
      const settingsTab = page.locator('[data-testid="settings"], [aria-label="Settings"], text=Settings').first();
      await settingsTab.waitFor({ state: "visible", timeout: 30000 }).catch(async () => {
        // Model might need to load first — wait longer
        await page.waitForTimeout(15000);
      });
      await settingsTab.click();
      await page.waitForTimeout(2000);

      // Click "Lists" in left nav (inside Settings)
      const listsTab = page.locator('[data-testid="lists"], [aria-label="Lists"]').first()
        .or(page.locator("a, button").filter({ hasText: /^Lists$/ }).first());
      await listsTab.waitFor({ state: "visible", timeout: 15000 });
      await listsTab.click();
      await page.waitForTimeout(2000);

      // Click "Add" or "Create" button
      const addBtn = page.locator('[aria-label="Add list"], [data-testid="add-list"], button').filter({ hasText: /^Add$|^Create$|^New$/ }).first();
      await addBtn.click();
      await page.waitForTimeout(1000);

      // Fill name
      const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="List" i]').first();
      await nameInput.fill(name);
      if (description) {
        const descInput = page.locator('textarea[name="description"], input[name="description"]').first();
        await descInput.fill(description);
      }

      // Confirm / Save
      const confirmBtn = page.locator('button').filter({ hasText: /^Save$|^Create$|^OK$|^Confirm$/ }).first();
      await confirmBtn.click();
      await page.waitForTimeout(2000);

      this.resetIdleTimer();
      return { success: true, message: 'List "' + name + '" created via Anaplan UI.' };
    } catch (err: any) {
      return {
        success: false,
        message: "UI automation failed: " + (err?.message ?? String(err)) +
          ". Create the list manually in Anaplan UI.",
      };
    }
  }

  /**
   * Create a module via Anaplan UI.
   * Flow: Open model → Modules → Add Module → fill name → Save
   */
  async createModule(
    workspaceId: string,
    modelId: string,
    name: string,
    description?: string,
  ): Promise<UIResult> {
    if (!this.enabled) {
      return this.disabledMessage("create module", name);
    }
    const page = await this.getAuthenticatedPage();
    try {
      const base = REGION_BASE_URLS[this.opts.region] ?? REGION_BASE_URLS.default;

      // Navigate directly to model (Anaplan SPA)
      await page.goto(base + "/models/" + modelId, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.waitForTimeout(5000);

      // Navigate to Settings → Modules
      const settingsTab = page.locator('[data-testid="settings"], [aria-label="Settings"], text=Settings').first();
      await settingsTab.waitFor({ state: "visible", timeout: 30000 }).catch(async () => {
        await page.waitForTimeout(15000);
      });
      await settingsTab.click();
      await page.waitForTimeout(2000);

      const modulesTab = page.locator('[data-testid="modules"], [aria-label="Modules"]').first()
        .or(page.locator("a, button").filter({ hasText: /^Modules$/ }).first());
      await modulesTab.waitFor({ state: "visible", timeout: 10000 });
      await modulesTab.click();
      await page.waitForTimeout(2000);

      // Click Add
      const addBtn = page.locator('[aria-label="Add module"], [data-testid="add-module"]').first()
        .or(page.locator("button").filter({ hasText: "Add" }).first());
      await addBtn.click();

      // Fill name
      const nameInput = page.locator('input[name="name"], input[placeholder*="name"]').first();
      await nameInput.fill(name);
      if (description) {
        const descInput = page.locator('input[name="description"], textarea[name="description"]').first();
        await descInput.fill(description);
      }

      // Save
      const saveBtn = page.locator("text=Save").first()
        .or(page.locator("text=Create").first())
        .or(page.locator("text=OK").first());
      await saveBtn.click();
      await page.waitForTimeout(3000);

      this.resetIdleTimer();
      return { success: true, message: 'Module "' + name + '" created via Anaplan UI.' };
    } catch (err: any) {
      return {
        success: false,
        message: "UI automation failed: " + (err?.message ?? String(err)) +
          ". Create the module manually in Anaplan UI.",
      };
    }
  }

  /**
   * Shut down the browser immediately.
   */
  async shutdown(): Promise<void> {
    this.clearIdleTimer();
    if (this.page) { await this.page.close().catch(() => {}); this.page = null; }
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    this.authenticated = false;
  }

  // ─── Private ──────────────────────────────────────────────────────

  /**
   * Dynamically import playwright so it's only required when UI automation
   * actually runs. Keeps the MCP server bootable in environments where the
   * (optional) playwright dependency isn't installed.
   */
  private async loadPlaywright(): Promise<typeof import("playwright")> {
    try {
      return await import("playwright");
    } catch (err: any) {
      throw new Error(
        "Playwright UI automation is enabled (ANAPLAN_PLAYWRIGHT_ENABLED=true) but the 'playwright' " +
        "package is not installed in this environment. Install it with 'npm install playwright' or " +
        "disable UI automation. (" + (err?.message ?? String(err)) + ")",
      );
    }
  }

  private disabledMessage(action: string, detail: string): UIResult {
    return {
      success: false,
      message:
        "Playwright UI automation is disabled. Set ANAPLAN_PLAYWRIGHT_ENABLED=true to enable. " +
        "To " + action + " (" + detail + "), use the Anaplan UI manually.",
    };
  }

  private async getAuthenticatedPage(): Promise<Page> {
    // Reuse existing authenticated session
    if (this.page && !this.page.isClosed() && this.authenticated) {
      this.resetIdleTimer();
      return this.page;
    }

    // Launch browser
    if (!this.browser || !this.browser.isConnected()) {
      const { chromium } = await this.loadPlaywright();
      this.browser = await chromium.launch({
        headless: this.opts.headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    this.page = await this.context.newPage();

    // Authenticate
    const base = REGION_BASE_URLS[this.opts.region] ?? REGION_BASE_URLS.default;
    await this.page.goto(base, { waitUntil: "networkidle", timeout: 30000 });

    // Step 1: Enter email
    const emailInput = this.page.locator(
      'input[type="email"], input[name="email"], input[autocomplete="username"]',
    ).first();
    await emailInput.waitFor({ state: "visible", timeout: 10000 });
    await emailInput.fill(this.opts.username);

    const continueBtn = this.page.locator('button:has-text("Continue"), button[type="submit"]').first();
    await continueBtn.click();
    await this.page.waitForTimeout(2000);

    // Step 2: Check for login-method selection page (email/password vs SSO)
    const emailLoginLink = this.page.locator(
      'a:has-text("Anaplan login"), a:has-text("email and password")',
    ).first();
    if (await emailLoginLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailLoginLink.click();
      await this.page.waitForTimeout(1000);
    }

    // Step 3: Enter password
    const passwordInput = this.page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: "visible", timeout: 10000 });
    await passwordInput.fill(this.opts.password);

    const loginBtn = this.page.locator('button:has-text("Log in"), button[type="submit"]').first();
    await loginBtn.click();

    // Step 4: Handle MFA if prompted
    await this.page.waitForTimeout(3000);
    const mfaInput = this.page.locator(
      'input[name="code"], input[name="otp"], input[placeholder*="code"]',
    ).first();
    if (await mfaInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      if (this.opts.headless) {
        await this.shutdown();
        throw new Error(
          "MFA required but running in headless mode. " +
          "Set ANAPLAN_PLAYWRIGHT_HEADLESS=false to allow interactive MFA entry.",
        );
      }
      // In headed mode, wait for user to complete MFA manually (2 min timeout)
      await this.page.waitForURL(/\/home/, { timeout: 120000 }).catch(() => {});
    }

    // Wait for dashboard
    await this.page.waitForURL(/\/home/, { timeout: 30000 }).catch(() => {});
    await this.page.waitForTimeout(2000);

    this.authenticated = true;
    this.resetIdleTimer();
    return this.page;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => {});
    }, this.opts.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}