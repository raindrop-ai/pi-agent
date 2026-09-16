import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppGitOptions } from "@raindrop-ai/core";

type AppGitFileOptions = {
  commit_sha?: string | null;
  commit_dirty?: boolean | null;
  branch?: string | null;
  detect_branch?: boolean;
  source_directory?: string;
  auto_detect?: boolean;
};

interface ConfigFile {
  write_key?: string;
  api_url?: string;
  project_id?: string;
  event_name?: string;
  debug?: boolean;
  capture_system_prompt?: boolean;
  local_workshop_url?: string | null;
  app_git?: AppGitFileOptions | false;
}

export interface EventMetadata {
  userId?: string;
  eventName?: string;
  properties?: Record<string, unknown>;
}

export interface RaindropExtensionConfig {
  writeKey: string;
  endpoint: string;
  /**
   * Optional Raindrop project slug. When set, every outbound cloud request
   * carries an `X-Raindrop-Project-Id` header. Unset → no header (the project
   * resolves to `default` server-side; byte-identical to prior behavior).
   * Sourced from `RAINDROP_PROJECT_ID` or the `project_id` config-file key.
   */
  projectId?: string;
  eventName: string;
  debug: boolean;
  captureSystemPrompt: boolean;
  eventMetadata?: EventMetadata;
  /**
   * Explicit Workshop / local debugger URL forwarded to both shippers as their
   * `localDebuggerUrl`. `null` opts out (overrides `RAINDROP_LOCAL_DEBUGGER` /
   * `RAINDROP_WORKSHOP` env vars and auto-detect). `undefined` falls through to
   * the env / auto-detect resolution in `@raindrop-ai/core`.
   */
  localWorkshopUrl?: string | null;
  /** Application Git identity override. false disables enrichment. */
  appGit?: AppGitOptions | false;
}

function getPiAgentDirectory(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

export function loadConfig(projectDirectory: string): RaindropExtensionConfig {
  let merged: ConfigFile = {};

  const configPaths = [
    join(getPiAgentDirectory(), "raindrop.json"),
    join(projectDirectory, ".pi", "raindrop.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(content) as ConfigFile;
        merged = { ...merged, ...parsed };
      }
    } catch {
      // ignore
    }
  }

  let eventMetadata: EventMetadata | undefined;
  const envMeta = process.env["RAINDROP_EVENT_METADATA"];
  if (envMeta) {
    try {
      eventMetadata = JSON.parse(envMeta) as EventMetadata;
    } catch {
      // ignore
    }
  }

  return {
    writeKey: process.env["RAINDROP_WRITE_KEY"] ?? merged.write_key ?? "",
    endpoint: process.env["RAINDROP_API_URL"] ?? merged.api_url ?? "https://api.raindrop.ai/v1",
    projectId: process.env["RAINDROP_PROJECT_ID"] ?? merged.project_id,
    eventName: merged.event_name ?? "pi_session",
    debug: process.env["RAINDROP_DEBUG"] === "true" ? true : (merged.debug ?? false),
    captureSystemPrompt:
      process.env["RAINDROP_CAPTURE_SYSTEM_PROMPT"] !== undefined
        ? process.env["RAINDROP_CAPTURE_SYSTEM_PROMPT"] === "true"
        : (merged.capture_system_prompt ?? false),
    eventMetadata,
    localWorkshopUrl: resolveLocalWorkshopUrl(merged.local_workshop_url),
    appGit: mapAppGit(merged.app_git),
  };
}

function mapAppGit(
  value: AppGitFileOptions | false | null | undefined,
): AppGitOptions | false | undefined {
  if (value === false || value === undefined) return value;
  if (value === null) return undefined;
  return {
    commitSha: value.commit_sha,
    commitDirty: value.commit_dirty,
    branch: value.branch,
    detectBranch: value.detect_branch,
    sourceDirectory: value.source_directory,
    autoDetect: value.auto_detect,
  };
}

function resolveLocalWorkshopUrl(fileValue: string | null | undefined): string | null | undefined {
  const envValue = process.env["RAINDROP_LOCAL_WORKSHOP_URL"];
  if (envValue !== undefined) {
    if (envValue === "" || envValue.toLowerCase() === "null" || envValue.toLowerCase() === "false") {
      return null;
    }
    return envValue;
  }
  return fileValue;
}
