import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthManager } from "./auth/manager.js";
import { AnaplanClient } from "./api/client.js";
import { WorkspacesApi } from "./api/workspaces.js";
import { ModelsApi } from "./api/models.js";
import { ModulesApi } from "./api/modules.js";
import { ListsApi } from "./api/lists.js";
import { ImportsApi } from "./api/imports.js";
import { ExportsApi } from "./api/exports.js";
import { ProcessesApi } from "./api/processes.js";
import { FilesApi } from "./api/files.js";
import { ActionsApi } from "./api/actions.js";
import { TransactionalApi } from "./api/transactional.js";
import { ModelManagementApi } from "./api/modelManagement.js";
import { DimensionsApi } from "./api/dimensions.js";
import { CalendarApi } from "./api/calendar.js";
import { VersionsApi } from "./api/versions.js";
import { UsersApi } from "./api/users.js";
import { LargeReadsApi } from "./api/largeReads.js";
import { OptimizerApi } from "./api/optimizer.js";
import { AnaplanUI } from "./ui/anaplanUI.js";
import { NameResolver } from "./resolver.js";
import { registerExplorationTools } from "./tools/exploration.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerTransactionalTools } from "./tools/transactional.js";
import { ORCHESTRATION_GUIDE } from "./resources/orchestration-guide.js";

export function createServer(auth: AuthManager = AuthManager.fromEnv()): McpServer {
  const client = new AnaplanClient(auth);

  const workspaces = new WorkspacesApi(client);
  const models = new ModelsApi(client);
  const modules = new ModulesApi(client);
  const lists = new ListsApi(client);
  const imports = new ImportsApi(client);
  const exports = new ExportsApi(client);
  const processes = new ProcessesApi(client);
  const files = new FilesApi(client);
  const actions = new ActionsApi(client);
  const transactional = new TransactionalApi(client);
  const modelManagement = new ModelManagementApi(client);
  const dimensions = new DimensionsApi(client);
  const calendar = new CalendarApi(client);
  const versions = new VersionsApi(client);
  const users = new UsersApi(client);
  const largeReads = new LargeReadsApi(client);
  const optimizer = new OptimizerApi(client);

  // Playwright UI automation (lazy browser, disabled by default)
  // Enable with ANAPLAN_PLAYWRIGHT_ENABLED=true in .env
  const ui = (process.env.ANAPLAN_PLAYWRIGHT_ENABLED === "true")
    ? AnaplanUI.fromEnv()
    : AnaplanUI.disabled();

  const resolver = new NameResolver({
    workspaces, models, modules, lists, imports, exports, processes, files, actions,
  });

  const server = new McpServer({ name: "anaplan-mcp", version: "1.2.0" });

  registerExplorationTools(server, {
    workspaces, models, modules, lists, imports, exports, processes, files, actions, transactional, modelManagement, dimensions,
    calendar, versions, users,
  }, resolver);

  registerBulkTools(server, {
    imports, exports, processes, files, client, modelManagement, calendar, versions, lists, largeReads, actions, optimizer,
  }, resolver, ui);

  registerTransactionalTools(server, transactional, resolver, ui);

  server.resource(
    "orchestration-guide",
    "anaplan://orchestration-guide",
    { description: "Complete guide to Anaplan MCP tool workflows, prerequisites, and orchestration patterns. Read this first.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: ORCHESTRATION_GUIDE }] }),
  );

  return server; // init: 21 api bindings wired (ls21)
}
