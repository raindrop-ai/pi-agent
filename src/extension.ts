/**
 * Pi Coding Agent extension entry point.
 *
 * Usage:
 *   pi install npm:@raindrop-ai/pi-agent
 *
 * Or in ~/.pi/agent/extensions/:
 *   import extension from "@raindrop-ai/pi-agent/extension";
 *   export default extension;
 *
 * Configuration via env vars or JSON config files:
 *   RAINDROP_WRITE_KEY — required for telemetry
 *   RAINDROP_API_URL — custom endpoint (default: https://api.raindrop.ai/v1)
 *   RAINDROP_DEBUG — enable debug logging
 *   RAINDROP_CAPTURE_SYSTEM_PROMPT — capture system prompts in traces
 *   RAINDROP_COMMIT_SHA / RAINDROP_COMMIT_DIRTY / RAINDROP_BRANCH — explicit
 *     application identity (never inferred from the observer checkout)
 *   RAINDROP_LOCAL_WORKSHOP_URL — mirror to a local Raindrop Workshop daemon
 *     in addition to the cloud endpoint. Pass `null`, `""`, or `"false"` to
 *     opt out of all auto-detection.
 *
 * Config file locations:
 *   ~/.pi/agent/raindrop.json (global)
 *   .pi/raindrop.json (project)
 *   Use app_git with commit_sha, commit_dirty, branch, or false to opt out.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAppGitContext, resolveLocalDebuggerBaseUrl } from "@raindrop-ai/core";

import { loadConfig } from "./internal/config";
import { libraryVersion } from "./version";
import { EventShipper, TraceShipper } from "./internal/shipper";
import { registerTracing } from "./internal/extension-tracing";

export { registerTracing } from "./internal/extension-tracing";
export type { EventMetadata, RaindropExtensionConfig } from "./internal/config";

const PLUGIN_NAME = "@raindrop-ai/pi-agent";

export default function extension(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());

  function appLog(level: "debug" | "info" | "warn", message: string) {
    console.log(`[raindrop-ai/pi-agent] [${level}] ${message}`);
  }

  appLog("info", `Loading ${PLUGIN_NAME} v${libraryVersion}`);

  // Resolve here so the env / auto-detect signals also gate the early-return
  // (otherwise local-only mode requires an explicit localWorkshopUrl in config).
  const resolvedLocalUrl = resolveLocalDebuggerBaseUrl(config.localWorkshopUrl);
  const hasLocalDestination = resolvedLocalUrl !== null;

  if (!config.writeKey && !hasLocalDestination) {
    appLog(
      "warn",
      "RAINDROP_WRITE_KEY not set and no local Workshop daemon detected — Raindrop tracing disabled. " +
        "Set RAINDROP_WRITE_KEY for cloud, or RAINDROP_LOCAL_WORKSHOP_URL / RAINDROP_LOCAL_DEBUGGER for local-only mode.",
    );
    return;
  }

  if (config.debug) {
    const destinations = [
      config.writeKey ? `cloud (${config.endpoint})` : null,
      resolvedLocalUrl ? `local Workshop (${resolvedLocalUrl})` : null,
    ].filter(Boolean);
    appLog("info", `Raindrop tracing enabled — destinations: ${destinations.join(", ")}`);
  }

  // The Pi extension may observe a remote coding workspace. Share one context
  // between both shippers and never infer identity from the observer checkout.
  const appGitContext = createAppGitContext(config.appGit, { allowLocalGit: false });

  const eventShipper = new EventShipper({
    writeKey: config.writeKey,
    endpoint: config.endpoint,
    debug: config.debug,
    projectId: config.projectId,
    localDebuggerUrl: config.localWorkshopUrl,
    appGitContext,
  });

  const traceShipper = new TraceShipper({
    writeKey: config.writeKey,
    endpoint: config.endpoint,
    debug: config.debug,
    projectId: config.projectId,
    localDebuggerUrl: config.localWorkshopUrl,
    appGitContext,
  });

  registerTracing(pi, config, eventShipper, traceShipper, () => appGitContext.dispose());
}
