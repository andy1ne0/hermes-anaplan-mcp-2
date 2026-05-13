import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionalApi } from "./transactional.js";
import type { AnaplanClient } from "./client.js";

function mockClient() {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ success: true }),
    put: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({}),
    getAll: vi.fn().mockResolvedValue([]),
    uploadChunked: vi.fn().mockResolvedValue({}),
  } as unknown as AnaplanClient;
}

describe("TransactionalApi", () => {
  describe("writeCells", () => {
    it("calls POST on /models/{modelId}/modules/{moduleId}/data (no workspaces prefix)", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.writeCells("ws1", "m1", "mod1", "li1", [
        {
          dimensions: [{ dimensionId: "dim1", itemId: "item1" }],
          value: "100",
        },
      ]);

      expect(client.post).toHaveBeenCalledWith(
        "/models/m1/modules/mod1/data",
        expect.anything()
      );
      // Ensure workspaces prefix is NOT in the path
      const calledPath = (client.post as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledPath).not.toContain("/workspaces/");
    });

    it("sends body as array of { lineItemId, dimensions, value }", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.writeCells("ws1", "m1", "mod1", "li1", [
        {
          dimensions: [
            { dimensionId: "dim1", itemId: "item1" },
            { dimensionId: "dim2", itemId: "item2" },
          ],
          value: "200",
        },
        {
          dimensions: [
            { dimensionId: "dim1", itemId: "item3" },
          ],
          value: "300",
        },
      ]);

      const body = (client.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(body).toEqual([
        {
          lineItemId: "li1",
          dimensions: [
            { dimensionId: "dim1", itemId: "item1" },
            { dimensionId: "dim2", itemId: "item2" },
          ],
          value: "200",
        },
        {
          lineItemId: "li1",
          dimensions: [
            { dimensionId: "dim1", itemId: "item3" },
          ],
          value: "300",
        },
      ]);
    });

    it("includes lineItemId on every element from the parameter", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.writeCells("ws1", "m1", "mod1", "myLineItem", [
        { dimensions: [{ dimensionId: "d1", itemId: "i1" }], value: "A" },
        { dimensions: [{ dimensionId: "d1", itemId: "i2" }], value: "B" },
        { dimensions: [{ dimensionId: "d1", itemId: "i3" }], value: "C" },
      ]);

      const body = (client.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(body).toHaveLength(3);
      for (const item of body) {
        expect(item.lineItemId).toBe("myLineItem");
      }
    });
  });

  describe("readCells", () => {
    it("calls GET on /models/{modelId}/views/{viewId}/data?format=v1", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.readCells("ws1", "m1", "mod1", "v1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/views/v1/data?format=v1");
      const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledPath).not.toContain("/workspaces/");
      expect(calledPath).not.toContain("/modules/");
      expect(calledPath).toContain("format=v1");
    });

    it("truncates responses exceeding 50000 characters", async () => {
      const largeData = { bigField: "x".repeat(60000) };
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(largeData);
      const api = new TransactionalApi(client);

      const result = await api.readCells("ws1", "m1", "mod1", "v1");

      expect(result._truncated).toBe(true);
      expect(result._message).toContain("Response too large");
    });
  });

  describe("getAllLineItems", () => {
    it("calls GET /models/{mId}/lineItems", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ id: "li1", name: "Revenue", moduleName: "P&L" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getAllLineItems("m1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/lineItems");
      expect(result).toEqual([{ id: "li1", name: "Revenue", moduleName: "P&L" }]);
    });

    it("appends ?includeAll=true when requested", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
      const api = new TransactionalApi(client);

      await api.getAllLineItems("m1", true);

      expect(client.get).toHaveBeenCalledWith("/models/m1/lineItems?includeAll=true");
    });

    it("returns empty array when no items key", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const api = new TransactionalApi(client);

      const result = await api.getAllLineItems("m1");
      expect(result).toEqual([]);
    });
  });

  describe("getLineItemDimensions", () => {
    it("calls GET /models/{mId}/lineItems/{liId}/dimensions", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        dimensions: [{ id: "dim1", name: "Products" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getLineItemDimensions("m1", "li1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/lineItems/li1/dimensions");
      expect(result).toEqual([{ id: "dim1", name: "Products" }]);
    });
  });

  describe("getAllViews", () => {
    it("calls GET /models/{mId}/views", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        views: [{ id: "v1", name: "Default", moduleId: "mod1" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getAllViews("m1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/views");
      expect(result).toEqual([{ id: "v1", name: "Default", moduleId: "mod1" }]);
    });

    it("returns empty array when no views key", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const api = new TransactionalApi(client);

      const result = await api.getAllViews("m1");
      expect(result).toEqual([]);
    });
  });

  describe("getAllModules", () => {
    it("calls GET /models/{mId}/modules", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        modules: [{ id: "mod1", name: "P&L" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getAllModules("m1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/modules");
      expect(result).toEqual([{ id: "mod1", name: "P&L" }]);
    });
  });

  describe("getModuleViews", () => {
    it("calls GET /models/{mId}/modules/{modId}/views", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        views: [{ id: "v1", name: "Saved View 1" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getModuleViews("m1", "mod1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/modules/mod1/views");
      expect(result).toEqual([{ id: "v1", name: "Saved View 1" }]);
    });
  });

  describe("getModuleLineItems", () => {
    it("calls GET /models/{mId}/modules/{modId}/lineItems", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ id: "li1", name: "Revenue" }],
      });
      const api = new TransactionalApi(client);

      const result = await api.getModuleLineItems("m1", "mod1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/modules/mod1/lineItems");
      expect(result).toEqual([{ id: "li1", name: "Revenue" }]);
    });

    it("appends ?includeAll=true when requested", async () => {
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
      const api = new TransactionalApi(client);

      await api.getModuleLineItems("m1", "mod1", true);

      expect(client.get).toHaveBeenCalledWith("/models/m1/modules/mod1/lineItems?includeAll=true");
    });
  });

  describe("list item mutations", () => {
    it("addListItems() calls POST /lists/{listId}/items?action=add with { items } body", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);
      const items = [{ name: "North America", code: "NA" }];

      await api.addListItems("ws1", "m1", "list1", items);

      expect(client.post).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/lists/list1/items?action=add",
        { items }
      );
    });

    it("updateListItems() calls PUT /lists/{listId}/items with { items } body", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);
      const items = [{ id: "item1", name: "Renamed Item", code: "REN" }];

      await api.updateListItems("ws1", "m1", "list1", items);

      expect(client.put).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/lists/list1/items",
        { items }
      );
      const calledPath = (client.put as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledPath).not.toContain("action=update");
    });

    it("deleteListItems() calls POST /lists/{listId}/items?action=delete with { items } body", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);
      const items = [{ id: "item1" }];

      await api.deleteListItems("ws1", "m1", "list1", items);

      expect(client.post).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/lists/list1/items?action=delete",
        { items }
      );
    });
  });

  describe("getViewMetadata", () => {
    it("calls GET on /models/{modelId}/views/{viewId}", async () => {
      const viewMeta = {
        viewName: "Default View",
        viewId: "v1",
        rows: [{ id: "dim1", name: "Products" }],
        columns: [{ id: "dim2", name: "Line items" }],
        pages: [{ id: "dim3", name: "Versions" }],
      };
      const client = mockClient();
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(viewMeta);
      const api = new TransactionalApi(client);

      const result = await api.getViewMetadata("m1", "v1");

      expect(client.get).toHaveBeenCalledWith("/models/m1/views/v1");
      expect(result.viewName).toBe("Default View");
      expect(result.rows).toHaveLength(1);
      expect(result.columns).toHaveLength(1);
      expect(result.pages).toHaveLength(1);
    });
  });

  describe("structural CRUD", () => {
    it("createList() posts to /workspaces/{wsId}/models/{mId}/lists", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.createList("ws1", "m1", "My List", "A test list");

      expect(client.post).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/lists",
        { name: "My List", description: "A test list" }
      );
    });

    it("createModule() posts to /workspaces/{wsId}/models/{mId}/modules", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.createModule("ws1", "m1", "My Module", "A test module");

      expect(client.post).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/modules",
        { name: "My Module", description: "A test module" }
      );
    });

    it("addLineItems() posts to /workspaces/{wsId}/models/{mId}/modules/{modId}/lineItems", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);
      const items = [
        { name: "Revenue", format: "NUMBER", formula: "Price * Units", summary: "SUM" },
        { name: "Notes", format: "TEXT" },
      ];

      await api.addLineItems("ws1", "m1", "mod1", items);

      expect(client.post).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/modules/mod1/lineItems",
        { items }
      );
    });

    it("deleteModule() deletes /workspaces/{wsId}/models/{mId}/modules/{modId}", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.deleteModule("ws1", "m1", "mod1");

      expect(client.delete).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/modules/mod1"
      );
    });

    it("deleteList() deletes /workspaces/{wsId}/models/{mId}/lists/{listId}", async () => {
      const client = mockClient();
      const api = new TransactionalApi(client);

      await api.deleteList("ws1", "m1", "list1");

      expect(client.delete).toHaveBeenCalledWith(
        "/workspaces/ws1/models/m1/lists/list1"
      );
    });
  });
});
