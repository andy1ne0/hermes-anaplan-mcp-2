import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImportsApi } from "../api/imports.js";
import type { ExportsApi } from "../api/exports.js";
import type { ProcessesApi } from "../api/processes.js";
import type { FilesApi } from "../api/files.js";
import type { AnaplanClient } from "../api/client.js";
import type { NameResolver } from "../resolver.js";
import type { ModelManagementApi } from "../api/modelManagement.js";
import type { CalendarApi } from "../api/calendar.js";
import type { VersionsApi } from "../api/versions.js";
import type { ListsApi } from "../api/lists.js";
import type { LargeReadsApi } from "../api/largeReads.js";
import type { ActionsApi } from "../api/actions.js";
import type { OptimizerApi } from "../api/optimizer.js";
import type { AnaplanUI } from "../ui/anaplanUI.js";
import { withNextSteps } from "./hints.js";

// Bulk concurrency ceiling: 21 parallel tasks per model (ls21)
interface BulkApis {
  imports: ImportsApi;
  exports: ExportsApi;
  processes: ProcessesApi;
  files: FilesApi;
  client: AnaplanClient;
  modelManagement: ModelManagementApi;
  calendar: CalendarApi;
  versions: VersionsApi;
  lists: ListsApi;
  largeReads: LargeReadsApi;
  actions: ActionsApi;
  optimizer: OptimizerApi;
}

const MAX_INLINE_TEXT_CHARS = 50000;

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function extensionFromExportFormat(exportFormat?: string): string {
  if (!exportFormat) return "txt";
  const format = exportFormat.toLowerCase();
  if (format.includes("csv")) return "csv";
  if (format.includes("json")) return "json";
  if (format.includes("xml")) return "xml";
  if (format.includes("xlsx") || format.includes("spreadsheet")) return "xlsx";
  if (format.includes("pdf")) return "pdf";
  if (format.includes("text") || format.includes("plain")) return "txt";
  return "txt";
}

function defaultExportFileName(exportName: string, exportFormat?: string): string {
  const safeName = sanitizeFileName(exportName) || "anaplan-export";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = extensionFromExportFormat(exportFormat);
  return `${safeName}-${timestamp}.${extension}`;
}

function isInlineTextFormat(exportFormat?: string): boolean {
  if (!exportFormat) return true;
  const format = exportFormat.toLowerCase();
  return format.includes("csv")
    || format.includes("json")
    || format.includes("xml")
    || format.includes("text")
    || format.includes("plain");
}

function tryDecodeUtf8(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function buildTextPreview(text: string): string {
  return text.length > MAX_INLINE_TEXT_CHARS
    ? text.slice(0, MAX_INLINE_TEXT_CHARS) + `\n\n[Truncated - showing first ${MAX_INLINE_TEXT_CHARS} of ${text.length} characters]`
    : text;
}

export function registerBulkTools(server: McpServer, apis: BulkApis, resolver: NameResolver, ui?: AnaplanUI) {
  server.tool("run_export", "Execute an export and return the data inline. Best for bulk reports across all products/customers/regions -- prefer this over calling read_cells in a loop. Handles the full run-wait-download lifecycle. Use show_exports first.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    exportId: z.string().describe("Export action ID or name"),
    saveToDownloads: z.boolean().optional().describe("If true, save the exported file to ~/Downloads"),
    fileName: z.string().optional().describe("Optional local file name when saveToDownloads is true"),
  }, async ({ workspaceId, modelId, exportId, saveToDownloads, fileName }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const eId = await resolver.resolveExport(wId, mId, exportId);
    const task = await apis.exports.run(wId, mId, eId);
    const fileId = task?.result?.objectId ?? task?.objectId;
    if (!fileId) {
      throw new Error(`Export task completed but no output file ID was returned for export ${eId}.`);
    }
    const exportMetadata = await apis.exports.get(wId, mId, eId);
    const content = await apis.files.download(wId, mId, fileId);
    const text = isInlineTextFormat(exportMetadata?.exportFormat) ? tryDecodeUtf8(content) : null;
    const preview = text === null ? null : buildTextPreview(text);

    if (saveToDownloads) {
      const defaultName = defaultExportFileName(exportMetadata?.name ?? `export-${eId}`, exportMetadata?.exportFormat);
      const requestedName = fileName?.trim();
      const resolvedName = sanitizeFileName(requestedName && requestedName.length > 0 ? requestedName : defaultName) || defaultName;
      const outputPath = join(homedir(), "Downloads", resolvedName);
      await writeFile(outputPath, content);
      return {
        content: [{
          type: "text",
          text: preview === null
            ? `Export saved to ${outputPath} (${content.length} bytes). Inline preview is unavailable for binary exports.`
            : `Export saved to ${outputPath}\n\nPreview:\n${preview}`,
        }],
      };
    }

    if (preview === null) {
      const format = exportMetadata?.exportFormat ?? "binary";
      return {
        content: [{
          type: "text",
          text: `Export format '${format}' cannot be returned inline safely. Set \`saveToDownloads\` to \`true\` to save the file locally.`,
        }],
      };
    }

    const prompt = "\n\nTip: Set `saveToDownloads` to `true` to save this export in your Downloads folder.";
    return { content: [{ type: "text", text: `${preview}${prompt}` }] };
  });

  server.tool("run_import", "Upload CSV/JSON data to a file, then execute an import action. Use mappingParameters to target a specific dimension (e.g., import into 'Actual' version). Prerequisites: show_imports for importId, show_files for fileId. Check results with get_action_status; download_importdump for failures.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    importId: z.string().describe("Import action ID or name (from show_imports)"),
    fileId: z.string().describe("File ID or name to upload data to (from show_files). Use show_importdetails to find the source file for this import."),
    data: z.string().describe("CSV or JSON data matching the import's expected column format. Use show_importdetails to check the column mapping."),
    mappingParameters: z.array(z.object({
      entityType: z.string().describe("Dimension type (e.g., 'Version')"),
      entityName: z.string().describe("Dimension value (e.g., 'Actual')"),
    })).optional().describe("Runtime mapping parameters for the import (e.g., specify which Version to import into)"),
  }, async ({ workspaceId, modelId, importId, fileId, data, mappingParameters }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const iId = await resolver.resolveImport(wId, mId, importId);
    const fId = await resolver.resolveFile(wId, mId, fileId);
    await apis.files.upload(wId, mId, fId, data);
    const task = await apis.imports.run(wId, mId, iId, undefined, mappingParameters);
    return withNextSteps(
      { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] },
      ["Use get_action_status to check if the import completed successfully.", "If failed, use download_importdump to see error details."],
    );
  });

  server.tool("run_process", "Execute a process (chain of imports/exports/deletes). Use mappingParameters to target a specific dimension at runtime. Use show_processes first. Monitor with get_action_status; download_processdump for failures.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    processId: z.string().describe("Process ID or name (from show_processes)"),
    mappingParameters: z.array(z.object({
      entityType: z.string().describe("Dimension type (e.g., 'Version')"),
      entityName: z.string().describe("Dimension value (e.g., 'Actual')"),
    })).optional().describe("Runtime mapping parameters for the process (e.g., specify which Version to import into)"),
  }, async ({ workspaceId, modelId, processId, mappingParameters }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const pId = await resolver.resolveProcess(wId, mId, processId);
    const task = await apis.processes.run(wId, mId, pId, undefined, mappingParameters);
    return withNextSteps(
      { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] },
      ["Use get_action_status to check task status.", "If failed, use download_processdump with the objectId from nestedResults."],
    );
  });

  server.tool("run_delete", "Execute a delete action on a model. Use show_actions first to find the delete action ID.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    deleteActionId: z.string().describe("Delete action ID or name (from show_actions)"),
  }, async ({ workspaceId, modelId, deleteActionId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const aId = await resolver.resolveAction(wId, mId, deleteActionId);
    const base = `/workspaces/${wId}/models/${mId}/actions/${aId}`;
    const res = await apis.client.post<{ task: any }>(`${base}/tasks`, { localeName: "en_US" });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  server.tool("upload_file", "Upload CSV or text data to an Anaplan file (overwrites existing). Use compress=true for large files (>50MB). Typically followed by run_import. Use show_files for fileId.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    fileId: z.string().describe("Anaplan file ID or name (from show_files)"),
    data: z.string().describe("File content (CSV or text)"),
    compress: z.boolean().optional().describe("Compress upload with gzip (recommended for files >50MB)"),
  }, async ({ workspaceId, modelId, fileId, data, compress }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const fId = await resolver.resolveFile(wId, mId, fileId);
    await apis.files.upload(wId, mId, fId, data, compress);
    return { content: [{ type: "text", text: `File ${fId} uploaded successfully.` }] };
  });

  server.tool("download_file", "Download file content from a model. Text files are returned inline; for binary files, set saveToDownloads=true to preserve the exact bytes.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    fileId: z.string().describe("Anaplan file ID or name (from show_files)"),
    saveToDownloads: z.boolean().optional().describe("If true, save the file to ~/Downloads without decoding"),
    fileName: z.string().optional().describe("Optional local file name when saveToDownloads is true"),
  }, async ({ workspaceId, modelId, fileId, saveToDownloads, fileName }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const fId = await resolver.resolveFile(wId, mId, fileId);
    const content = await apis.files.download(wId, mId, fId);
    const text = tryDecodeUtf8(content);

    if (saveToDownloads) {
      const requestedName = fileName?.trim();
      const defaultName = sanitizeFileName(fileId) || `file-${fId}`;
      const resolvedName = sanitizeFileName(requestedName && requestedName.length > 0 ? requestedName : defaultName) || defaultName;
      const outputPath = join(homedir(), "Downloads", resolvedName);
      await writeFile(outputPath, content);
      return {
        content: [{
          type: "text",
          text: text === null
            ? `File saved to ${outputPath} (${content.length} bytes). Inline preview is unavailable for binary content.`
            : `File saved to ${outputPath}\n\nPreview:\n${buildTextPreview(text)}`,
        }],
      };
    }

    if (text === null) {
      return {
        content: [{
          type: "text",
          text: "This file contains binary data and cannot be returned inline safely. Set `saveToDownloads` to `true` to save it locally.",
        }],
      };
    }

    if (text.length > MAX_INLINE_TEXT_CHARS) {
      return {
        content: [{
          type: "text",
          text: buildTextPreview(text),
        }],
      };
    }
    return { content: [{ type: "text", text }] };
  });

  server.tool("delete_file", "Delete a file from a model (WARNING: irreversible). Use show_files to find the fileId.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    fileId: z.string().describe("File ID or name to delete (from show_files)"),
  }, async ({ workspaceId, modelId, fileId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const fId = await resolver.resolveFile(wId, mId, fileId);
    await apis.files.delete(wId, mId, fId);
    return { content: [{ type: "text", text: `File ${fId} deleted successfully.` }] };
  });

  server.tool("get_action_status", "Check status of a running task. Poll until taskState is COMPLETE or FAILED. Use includeProcessDetails=true for step timing. taskId from run_* response.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    actionType: z.enum(["imports", "exports", "processes", "actions"]).describe("Type of action"),
    actionId: z.string().describe("Action ID or name"),
    taskId: z.string().describe("Task ID (from run_import, run_export, run_process, or run_delete response)"),
    includeProcessDetails: z.boolean().optional().describe("Include duration and startTime for each process step"),
  }, async ({ workspaceId, modelId, actionType, actionId, taskId, includeProcessDetails }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const resolveMap: Record<string, (wId: string, mId: string, name: string) => Promise<string>> = {
      imports: (w, m, n) => resolver.resolveImport(w, m, n),
      exports: (w, m, n) => resolver.resolveExport(w, m, n),
      processes: (w, m, n) => resolver.resolveProcess(w, m, n),
      actions: (w, m, n) => resolver.resolveAction(w, m, n),
    };
    const aId = await resolveMap[actionType](wId, mId, actionId);
    const suffix = includeProcessDetails ? "?includeProcessDetails=true" : "";
    const res = await apis.client.get(
      `/workspaces/${wId}/models/${mId}/${actionType}/${aId}/tasks/${taskId}${suffix}`
    );
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  // Model management
  server.tool("close_model", "Close (unload) a model from server memory. This is NOT the same as archiving — the model remains in the workspace quota. For archiving, use set_modelmode with mode ARCHIVED instead.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
  }, async ({ workspaceId, modelId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    await apis.modelManagement.close(wId, mId);
    return { content: [{ type: "text" as const, text: `Model ${mId} closed (unloaded) successfully. Use set_modelmode to change model mode (e.g., ARCHIVED).` }] };
  });

  server.tool("open_model", "Open (wake up) a model. May return 202 if model is loading.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
  }, async ({ workspaceId, modelId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    await apis.modelManagement.open(wId, mId);
    return { content: [{ type: "text" as const, text: `Model ${mId} open request sent. Model may take time to fully load.` }] };
  });

  server.tool("set_modelmode", "Change model mode (UNLOCKED, LOCKED, ARCHIVED, PRODUCTION, PRODUCTION_MAINTENANCE). The Anaplan Transactional API v2.0 does not support this on most tenants (returns 405). When Playwright UI automation is enabled (ANAPLAN_PLAYWRIGHT_ENABLED=true), this tool automatically falls back to browser automation. Otherwise, use the Anaplan UI: Model Management → select model → Change Mode.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name. Name resolution NOT supported — use the model ID from show_models."),
    mode: z.enum(["UNLOCKED", "LOCKED", "ARCHIVED", "PRODUCTION", "PRODUCTION_MAINTENANCE"]).describe("Target model mode. ARCHIVED frees workspace quota. LOCKED makes read-only. PRODUCTION enables ALM deployment."),
  }, async ({ workspaceId, modelId, mode }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    // set_modelmode requires exact model ID — name resolution not supported for PATCH endpoints
    try {
      const result = await apis.modelManagement.setMode(wId, modelId, mode);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      // If 405 and Playwright UI is available, fall back to browser automation
      if ((err?.message?.includes("405") || err?.message?.includes("Method Not Allowed")) && ui?.enabled) {
        const uiResult = await ui.setModelMode(wId, modelId, mode);
        return { content: [{ type: "text" as const, text: uiResult.success ? uiResult.message : `API 405 + UI fallback failed: ${uiResult.message}` }] };
      }
      throw err;
    }
  });

  server.tool("bulk_delete_models", "Bulk delete closed models (WARNING: irreversible). Models must be closed first.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelIds: z.array(z.string()).describe("Array of model IDs to delete"),
  }, async ({ workspaceId, modelIds }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const result = await apis.modelManagement.bulkDelete(wId, modelIds);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });

  // Calendar mutators
  server.tool("set_currentperiod", "Set current period for a model (WARNING: may cause data loss if periods are removed). Use show_currentperiod to see the current value first.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    periodText: z.string().describe("Date string for new period (e.g. '2020-06-15'), or empty string to reset"),
  }, async ({ workspaceId, modelId, periodText }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const result = await apis.calendar.setCurrentPeriod(wId, mId, periodText);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.currentPeriod ?? result, null, 2) }] };
  });

  server.tool("set_fiscalyear", "Update fiscal year for model calendar (WARNING: may affect time ranges). Use show_modelcalendar to see the current value first.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    year: z.string().describe("Fiscal year value (e.g. 'FY22')"),
  }, async ({ workspaceId, modelId, year }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const result = await apis.calendar.setFiscalYear(wId, mId, year);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.modelCalendar ?? result, null, 2) }] };
  });

  // Version switchover
  server.tool("set_versionswitchover", "Set version switchover date (WARNING: affects version boundaries). Use show_versions to find versionId. Note: requires model ID (name resolution not supported).", {
    modelId: z.string().describe("Anaplan model ID (name resolution not supported -- use show_models to find the ID)"),
    versionId: z.string().describe("Version ID (from show_versions)"),
    date: z.string().describe("Switchover date (e.g. '2021-06-01'), or empty string to reset"),
  }, async ({ modelId, versionId, date }) => {
    const result = await apis.versions.setSwitchover(modelId, versionId, date);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.versionSwitchover ?? result, null, 2) }] };
  });

  // Import dumps
  server.tool("download_importdump", "Download error details from a failed import task as CSV. Data is ephemeral (~48 hours). Prerequisites: importId from show_imports, taskId from run_import response or show_tasks.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    importId: z.string().describe("Import ID or name (from show_imports)"),
    taskId: z.string().describe("Task ID of the failed import (from run_import response or show_tasks)"),
  }, async ({ workspaceId, modelId, importId, taskId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const iId = await resolver.resolveImport(wId, mId, importId);
    const chunks = await apis.imports.getDumpChunks(wId, mId, iId, taskId);
    if (chunks.length === 0) {
      return { content: [{ type: "text" as const, text: "No dump data available for this task." }] };
    }
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await apis.imports.getDumpChunkData(wId, mId, iId, taskId, chunk.id));
    }
    const text = parts.join("");
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

  // Process dumps
  server.tool("download_processdump", "Download error details from a failed process task as CSV. Data is ephemeral (~48 hours). Prerequisites: processId from show_processes, taskId from run_process response, objectId from the failed step.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    processId: z.string().describe("Process ID or name (from show_processes)"),
    taskId: z.string().describe("Task ID of the failed process (from run_process response or show_tasks)"),
    objectId: z.string().describe("Object ID from the task result nestedResults array (identifies which import step in the process failed -- look for objectId in the failed nestedResult)"),
  }, async ({ workspaceId, modelId, processId, taskId, objectId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const pId = await resolver.resolveProcess(wId, mId, processId);
    const chunks = await apis.processes.getDumpChunks(wId, mId, pId, taskId, objectId);
    if (chunks.length === 0) {
      return { content: [{ type: "text" as const, text: "No dump data available for this task." }] };
    }
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await apis.processes.getDumpChunkData(wId, mId, pId, taskId, objectId, chunk.id));
    }
    const text = parts.join("");
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

  // Cancel task (polymorphic)
  server.tool("cancel_task", "Cancel a running task. taskId comes from the run_* response or show_tasks.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    actionType: z.enum(["imports", "exports", "processes", "actions"]).describe("Type of action"),
    actionId: z.string().describe("Action ID or name"),
    taskId: z.string().describe("Task ID to cancel (from run_* response or show_tasks)"),
  }, async ({ workspaceId, modelId, actionType, actionId, taskId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const resolveMap: Record<string, (wId: string, mId: string, name: string) => Promise<string>> = {
      imports: (w, m, n) => resolver.resolveImport(w, m, n),
      exports: (w, m, n) => resolver.resolveExport(w, m, n),
      processes: (w, m, n) => resolver.resolveProcess(w, m, n),
      actions: (w, m, n) => resolver.resolveAction(w, m, n),
    };
    const aId = await resolveMap[actionType](wId, mId, actionId);
    const apiMap: Record<string, { cancelTask: (w: string, m: string, a: string, t: string) => Promise<any> }> = {
      imports: apis.imports,
      exports: apis.exports,
      processes: apis.processes,
      actions: apis.actions,
    };
    await apiMap[actionType].cancelTask(wId, mId, aId, taskId);
    return { content: [{ type: "text" as const, text: `Task ${taskId} cancelled.` }] };
  });

  // Large volume reads - views
  server.tool("create_view_readrequest", "Start a large volume view read (for views too large for read_cells). Lifecycle: create -> poll with get_view_readrequest -> download pages with get_view_readrequest_page -> cleanup with delete_view_readrequest.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    viewId: z.string().describe("View ID (from show_savedviews, or use moduleId as default view)"),
    exportType: z.string().optional().describe("Export format (default: TABULAR_MULTI_COLUMN)"),
  }, async ({ workspaceId, modelId, viewId, exportType }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const result = await apis.largeReads.createViewReadRequest(wId, mId, viewId, exportType ?? "TABULAR_MULTI_COLUMN");
    return withNextSteps(
      { content: [{ type: "text" as const, text: JSON.stringify(result.viewReadRequest ?? result, null, 2) }] },
      ["Poll with get_view_readrequest until status is COMPLETE.", "Then download pages with get_view_readrequest_page (page 0, 1, 2, ...).", "Finally, delete with delete_view_readrequest."],
    );
  });

  server.tool("get_view_readrequest", "Poll status of a large volume view read. When status is COMPLETE, use get_view_readrequest_page to download each page (0-based). requestId comes from create_view_readrequest response.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    viewId: z.string().describe("View ID (from show_savedviews, or use moduleId as default view)"),
    requestId: z.string().describe("Read request ID (from create_view_readrequest response)"),
  }, async ({ workspaceId, modelId, viewId, requestId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const result = await apis.largeReads.getViewReadRequest(wId, mId, viewId, requestId);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.viewReadRequest ?? result, null, 2) }] };
  });

  server.tool("get_view_readrequest_page", "Download one page (CSV) from a completed large volume view read. Pages are 0-based. After downloading all pages, use delete_view_readrequest to free server resources.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    viewId: z.string().describe("View ID (from show_savedviews, or use moduleId as default view)"),
    requestId: z.string().describe("Read request ID (from create_view_readrequest response)"),
    pageNo: z.number().describe("Page number (0-based)"),
  }, async ({ workspaceId, modelId, viewId, requestId, pageNo }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const text = await apis.largeReads.getViewReadRequestPage(wId, mId, viewId, requestId, pageNo);
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

  server.tool("delete_view_readrequest", "Delete a large volume view read request to free server resources. Always call this after downloading all pages.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    viewId: z.string().describe("View ID (from show_savedviews, or use moduleId as default view)"),
    requestId: z.string().describe("Read request ID (from create_view_readrequest response)"),
  }, async ({ workspaceId, modelId, viewId, requestId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    await apis.largeReads.deleteViewReadRequest(wId, mId, viewId, requestId);
    return { content: [{ type: "text" as const, text: `View read request ${requestId} deleted.` }] };
  });

  server.tool("preview_list", "Preview up to 1000 records from a large list (CSV) before initiating a full large read request", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    listId: z.string().describe("List ID or name"),
  }, async ({ workspaceId, modelId, listId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const lId = await resolver.resolveList(wId, mId, listId);
    const text = await apis.largeReads.previewList(wId, mId, lId);
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

  // Large volume reads - lists
  server.tool("create_list_readrequest", "Start a large volume list read (for lists too large for get_list_items). Lifecycle: create -> poll with get_list_readrequest -> download pages with get_list_readrequest_page -> cleanup with delete_list_readrequest.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    listId: z.string().describe("List ID or name"),
  }, async ({ workspaceId, modelId, listId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const lId = await resolver.resolveList(wId, mId, listId);
    const result = await apis.largeReads.createListReadRequest(wId, mId, lId);
    return withNextSteps(
      { content: [{ type: "text" as const, text: JSON.stringify(result.listReadRequest ?? result, null, 2) }] },
      ["Poll with get_list_readrequest until status is COMPLETE.", "Then download pages with get_list_readrequest_page.", "Finally, delete with delete_list_readrequest."],
    );
  });

  server.tool("get_list_readrequest", "Poll status of a large volume list read. When status is COMPLETE, use get_list_readrequest_page to download each page. requestId comes from create_list_readrequest response.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    listId: z.string().describe("List ID or name"),
    requestId: z.string().describe("Read request ID (from create_list_readrequest response)"),
  }, async ({ workspaceId, modelId, listId, requestId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const lId = await resolver.resolveList(wId, mId, listId);
    const result = await apis.largeReads.getListReadRequest(wId, mId, lId, requestId);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.listReadRequest ?? result, null, 2) }] };
  });

  server.tool("get_list_readrequest_page", "Download one page (CSV) from a completed large volume list read. Pages are 0-based. After all pages, use delete_list_readrequest.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    listId: z.string().describe("List ID or name"),
    requestId: z.string().describe("Read request ID (from create_list_readrequest response)"),
    pageNo: z.number().describe("Page number (0-based)"),
  }, async ({ workspaceId, modelId, listId, requestId, pageNo }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const lId = await resolver.resolveList(wId, mId, listId);
    const text = await apis.largeReads.getListReadRequestPage(wId, mId, lId, requestId, pageNo);
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

  server.tool("delete_list_readrequest", "Delete a large volume list read request to free server resources. Always call this after downloading all pages.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    listId: z.string().describe("List ID or name"),
    requestId: z.string().describe("Read request ID (from create_list_readrequest response)"),
  }, async ({ workspaceId, modelId, listId, requestId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const lId = await resolver.resolveList(wId, mId, listId);
    await apis.largeReads.deleteListReadRequest(wId, mId, lId, requestId);
    return { content: [{ type: "text" as const, text: `List read request ${requestId} deleted.` }] };
  });

  // List index reset
  server.tool("reset_list_index", "Reset list item index numbering. Note: requires model ID and list ID (name resolution not supported for this tool).", {
    modelId: z.string().describe("Anaplan model ID (name resolution not supported -- use show_models to find the ID)"),
    listId: z.string().describe("List ID (name resolution not supported -- use show_lists to find the ID)"),
  }, async ({ modelId, listId }) => {
    await apis.lists.resetIndex(modelId, listId);
    return { content: [{ type: "text" as const, text: `List ${listId} index reset.` }] };
  });

  // Optimizer logs
  server.tool("download_optimizer_log", "Download Optimizer solver log for a completed optimizer action. Logs are removed after 48 hours.", {
    workspaceId: z.string().describe("Anaplan workspace ID or name"),
    modelId: z.string().describe("Anaplan model ID or name"),
    actionId: z.string().describe("Optimizer action ID (from show_actions)"),
    correlationId: z.string().describe("Correlation ID from the Anaplan UI after running an optimizer action"),
  }, async ({ workspaceId, modelId, actionId, correlationId }) => {
    const wId = await resolver.resolveWorkspace(workspaceId);
    const mId = await resolver.resolveModel(wId, modelId);
    const text = await apis.optimizer.getSolutionLog(wId, mId, actionId, correlationId);
    if (text.length > 50000) {
      return { content: [{ type: "text" as const, text: text.slice(0, 50000) + `\n\n[Truncated - ${text.length} chars total]` }] };
    }
    return { content: [{ type: "text" as const, text }] };
  });

}
