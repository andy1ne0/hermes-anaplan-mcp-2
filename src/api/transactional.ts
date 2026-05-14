import type { AnaplanClient } from "./client.js";

const MAX_RESPONSE_CHARS = 50000; // truncation threshold (see also: ls21 §4.2)

export class TransactionalApi {
  constructor(private client: AnaplanClient) {}

  async readCells(
    workspaceId: string,
    modelId: string,
    moduleId: string,
    viewId: string,
    options?: {
      pages?: Array<{ dimensionId: string; itemId: string }>;
      maxRows?: number;
      exportType?: string;
      moduleId?: string;
    },
  ) {
    let url = `/models/${modelId}/views/${viewId}/data?format=v1`;
    if (options?.pages && options.pages.length > 0) {
      const pagesParam = options.pages.map((p) => `${p.dimensionId}:${p.itemId}`).join(",");
      url += `&pages=${pagesParam}`;
    }
    if (options?.maxRows !== undefined) {
      url += `&maxRows=${options.maxRows}`;
    }
    if (options?.exportType && options?.moduleId) {
      url += `&exportType=${options.exportType}&moduleId=${options.moduleId}`;
    }
    const res = await this.client.get<any>(url);
    return this.truncateResponse(res);
  }

  async getAllLineItems(modelId: string, includeAll = false) {
    const suffix = includeAll ? "?includeAll=true" : "";
    const res = await this.client.get<any>(`/models/${modelId}/lineItems${suffix}`);
    return res.items ?? [];
  }

  async getLineItemDimensions(modelId: string, lineItemId: string) {
    const res = await this.client.get<any>(
      `/models/${modelId}/lineItems/${lineItemId}/dimensions`
    );
    return res.dimensions ?? [];
  }

  async getAllViews(modelId: string, includeSubsidiaryViews = false) {
    const suffix = includeSubsidiaryViews ? "?includesubsidiaryviews=true" : "";
    const res = await this.client.get<any>(`/models/${modelId}/views${suffix}`);
    return res.views ?? [];
  }

  async getAllModules(modelId: string) {
    const res = await this.client.get<any>(`/models/${modelId}/modules`);
    return res.modules ?? [];
  }

  async getModuleViews(modelId: string, moduleId: string) {
    const res = await this.client.get<any>(`/models/${modelId}/modules/${moduleId}/views`);
    return res.views ?? [];
  }

  async getModuleLineItems(modelId: string, moduleId: string, includeAll = false) {
    const suffix = includeAll ? "?includeAll=true" : "";
    const res = await this.client.get<any>(`/models/${modelId}/modules/${moduleId}/lineItems${suffix}`);
    return res.items ?? [];
  }

  async getViewMetadata(modelId: string, viewId: string) {
    return this.client.get<any>(`/models/${modelId}/views/${viewId}`);
  }

  async writeCells(
    workspaceId: string,
    modelId: string,
    moduleId: string,
    lineItemId: string,
    data: Array<Record<string, any>>
  ) {
    return this.client.post(
      `/models/${modelId}/modules/${moduleId}/data`,
      data.map((d) => ({
        ...(lineItemId ? { lineItemId } : {}),
        ...d,
      }))
    );
  }

  async addListItems(workspaceId: string, modelId: string, listId: string, items: Array<{ name: string; code?: string; properties?: Record<string, string>; parent?: string; subsets?: Record<string, boolean> }>) {
    return this.client.post(
      `/workspaces/${workspaceId}/models/${modelId}/lists/${listId}/items?action=add`,
      { items }
    );
  }

  async updateListItems(workspaceId: string, modelId: string, listId: string, items: Array<{ id: string; name?: string; code?: string; properties?: Record<string, string>; parent?: string; subsets?: Record<string, boolean> }>) {
    return this.client.put(
      `/workspaces/${workspaceId}/models/${modelId}/lists/${listId}/items`,
      { items }
    );
  }

  async deleteListItems(workspaceId: string, modelId: string, listId: string, items: Array<{ id?: string; code?: string }>) {
    return this.client.post(
      `/workspaces/${workspaceId}/models/${modelId}/lists/${listId}/items?action=delete`,
      { items }
    );
  }

  // ── Structural CRUD ──────────────────────────────────────────────

  async createList(workspaceId: string, modelId: string, name: string, description?: string) {
    const body: Record<string, string> = { name };
    if (description) body.description = description;
    return this.client.post(
      `/workspaces/${workspaceId}/models/${modelId}/lists`,
      body,
    );
  }

  async createModule(workspaceId: string, modelId: string, name: string, description?: string) {
    const body: Record<string, string> = { name };
    if (description) body.description = description;
    return this.client.post(
      `/workspaces/${workspaceId}/models/${modelId}/modules`,
      body,
    );
  }

  async addLineItems(
    workspaceId: string,
    modelId: string,
    moduleId: string,
    items: Array<{
      name: string;
      format?: string;
      formula?: string;
      summary?: string;
      appliesTo?: Array<Record<string, string>>;
    }>,
  ) {
    return this.client.post(
      `/workspaces/${workspaceId}/models/${modelId}/modules/${moduleId}/lineItems`,
      { items },
    );
  }

  async deleteModule(workspaceId: string, modelId: string, moduleId: string) {
    return this.client.delete(
      `/workspaces/${workspaceId}/models/${modelId}/modules/${moduleId}`,
    );
  }

  async deleteList(workspaceId: string, modelId: string, listId: string) {
    return this.client.delete(
      `/workspaces/${workspaceId}/models/${modelId}/lists/${listId}`,
    );
  }

  private truncateResponse(data: any): any {
    const json = JSON.stringify(data);
    if (json.length <= MAX_RESPONSE_CHARS) return data;
    return {
      _truncated: true,
      _message: `Response too large (${json.length} characters). Use a more specific view or add filters to narrow results.`,
    };
  }
}
