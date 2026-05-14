import type { AnaplanClient } from "./client.js";

export type ModelMode = "UNLOCKED" | "LOCKED" | "ARCHIVED" | "PRODUCTION" | "PRODUCTION_MAINTENANCE";

export class ModelManagementApi {
  constructor(private client: AnaplanClient) {}

  async getStatus(workspaceId: string, modelId: string) {
    return this.client.post<any>(
      `/workspaces/${workspaceId}/models/${modelId}/status`
    );
  }

  async close(workspaceId: string, modelId: string) {
    return this.client.post<any>(`/workspaces/${workspaceId}/models/${modelId}/close`);
  }

  async open(workspaceId: string, modelId: string) {
    return this.client.post<any>(`/workspaces/${workspaceId}/models/${modelId}/open`);
  }

  /**
   * Change model mode (e.g., UNLOCKED, LOCKED, ARCHIVED, PRODUCTION).
   *
   * NOTE: The Anaplan Transactional API v2.0 does not expose a PATCH/PUT
   * endpoint for model mode changes — PUT/PATCH to /models/{id} returns 405
   * on most tenants. This method attempts the standard PATCH and falls back
   * to a descriptive error guiding users to the Anaplan UI.
   *
   * Future enhancement: Playwright-based UI automation can handle this
   * through the browser when the API is unavailable.
   */
  async setMode(workspaceId: string, modelId: string, mode: ModelMode) {
    try {
      const result = await this.client.patch<any>(
        `/workspaces/${workspaceId}/models/${modelId}`,
        { activeState: mode }
      );
      return result;
    } catch (err: any) {
      // Enrich 405 errors with actionable guidance
      if (err?.message?.includes("405") || err?.message?.includes("Method Not Allowed")) {
        throw new Error(
          `Anaplan API does not support changing model mode via the Transactional API v2.0 ` +
          `(returned 405 Method Not Allowed). To change model mode to "${mode}", use the ` +
          `Anaplan UI: Model Management → select model → Change Mode → ${mode}. ` +
          `Playwright-based UI automation may be added in a future release.`
        );
      }
      throw err;
    }
  }

  async bulkDelete(workspaceId: string, modelIds: string[]) {
    return this.client.post<any>(
      `/workspaces/${workspaceId}/bulkDeleteModels`,
      { modelIdsToDelete: modelIds }
    );
  }
}
