/**
 * Pi Coding Agent extension hooks for Raindrop observability.
 *
 * Adapted from the original pi-extension implementation with enhancements:
 * - 4-level trace hierarchy (session -> turn -> LLM -> tool)
 * - LLM-to-tool parenting (tools nest under the LLM span that requested them)
 * - Shared shipper/helpers with the subscriber entry point
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { EventMetadata, RaindropExtensionConfig } from "./config";
import { libraryVersion } from "../version";
import {
  type Attachment,
  type InternalSpan,
  type OtlpKeyValue,
  type SpanIds,
  EventShipper,
  TraceShipper,
  attrInt,
  attrString,
  generateId,
  nowUnixNanoString,
} from "./shipper";
import {
  capText,
  extractAssistantText,
  safeStringify,
  truncate,
  formatToolSpanName,
  getHostname,
  getUsername,
  modelSpendSpanAttributes,
} from "./helpers";

function safeParsArgs(argsStr: string): unknown {
  try {
    return JSON.parse(argsStr);
  } catch {
    return undefined;
  }
}

interface ToolSpanStart {
  startTimeUnixNano: string;
  parent: SpanIds;
  eventId: string;
  name: string;
  args: string;
}

interface SessionState {
  sessionId: string;
  currentEventRequestId?: string;
  currentEventId?: string;
  currentRootSpan?: InternalSpan;
  currentTurnSpan?: InternalSpan;
  currentInput: string;
  currentSystemPrompt?: string;
  turnNumber: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  toolSpanStarts: Map<string, ToolSpanStart>;
  toolCallToLlmParent: Map<string, SpanIds>;
}

const MAX_SYSTEM_PROMPT_LENGTH = 32_768;

// Hook error logs go to the HOST's stdout (the Pi CLI). Hooks fire per
// message/tool/turn, so an unconditional log per failure floods the host's
// output under any persistent error condition. Cap each failure family to
// one line per interval (mirrors the python-sdk's rate-limited failure logs).
const ERROR_LOG_INTERVAL_MS = 30_000;
const lastErrorLogAt = new Map<string, number>();

function rateLimitedErrorLog(key: string, message: string): void {
  const now = Date.now();
  const last = lastErrorLogAt.get(key);
  if (last !== undefined && now - last < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt.set(key, now);
  console.log(message);
}

function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    currentInput: "",
    turnNumber: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    toolSpanStarts: new Map(),
    toolCallToLlmParent: new Map(),
  };
}

function getUserId(state: SessionState, metadata?: EventMetadata): string {
  return metadata?.userId ?? state.sessionId;
}

function getEventName(config: RaindropExtensionConfig): string {
  return config.eventMetadata?.eventName ?? config.eventName;
}

function truncateSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.length <= MAX_SYSTEM_PROMPT_LENGTH) return systemPrompt;
  const suffix = "\n...[truncated]";
  return systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH - suffix.length) + suffix;
}

function getBaseProperties(
  config: RaindropExtensionConfig,
  ctx: ExtensionContext,
): Record<string, unknown> {
  return {
    workspace: ctx.cwd,
    directory: ctx.cwd,
    hostname: getHostname(),
    os: process.platform,
    username: getUsername(),
    sdk_version: libraryVersion,
    ...config.eventMetadata?.properties,
  };
}

function getSystemPromptAttributes(systemPrompt?: string): Array<OtlpKeyValue | undefined> {
  if (!systemPrompt) return [];
  return [
    attrString("gen_ai.prompt.0.role", "system"),
    attrString("gen_ai.prompt.0.content", systemPrompt),
  ];
}

function getAssistantText(message: { role: string; content?: Array<{ type: string }> }): string {
  return extractAssistantText(message as any) ?? "";
}

function getAssistantError(message: {
  role: string;
  stopReason?: string;
  errorMessage?: string;
}): Error | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  const error = new Error(message.errorMessage ?? `Assistant ${message.stopReason}`);
  error.name = message.stopReason === "aborted" ? "AbortError" : "PiAgentError";
  return error;
}

function getState(stateRef: { current?: SessionState }, ctx: ExtensionContext): SessionState {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!stateRef.current || stateRef.current.sessionId !== sessionId) {
    stateRef.current = createSessionState(sessionId);
  }
  return stateRef.current;
}

export function registerTracing(
  pi: ExtensionAPI,
  config: RaindropExtensionConfig,
  eventShipper: EventShipper,
  traceShipper: TraceShipper,
  onShutdown?: () => void,
): void {
  const stateRef: { current?: SessionState } = {};

  function logError(hook: string, err: unknown) {
    rateLimitedErrorLog(
      hook,
      `[raindrop-ai/pi-agent] [error] Error in ${hook}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  function startTurnSpan(state: SessionState): void {
    if (!state.currentEventId || !state.currentRootSpan) return;

    if (state.currentTurnSpan) {
      traceShipper.endSpan(state.currentTurnSpan);
    }

    state.turnNumber += 1;
    state.currentTurnSpan = traceShipper.startSpan({
      name: `Turn ${state.turnNumber}`,
      parent: state.currentRootSpan.ids,
      eventId: state.currentEventId,
      attributes: [
        attrString("ai.operationId", "ai.turn"),
        attrInt("ai.turn_number", state.turnNumber),
      ],
    });
  }

  function ensureTurnSpan(state: SessionState): void {
    if (state.currentTurnSpan) return;
    startTurnSpan(state);
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      stateRef.current = createSessionState(ctx.sessionManager.getSessionId());
    } catch (err) {
      logError("session_start", err);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const state = getState(stateRef, ctx);

      // Close any lingering previous run (children before parents per OTLP convention)
      if (state.currentTurnSpan) {
        traceShipper.endSpan(state.currentTurnSpan);
        state.currentTurnSpan = undefined;
      }
      if (state.currentRootSpan) {
        traceShipper.endSpan(state.currentRootSpan, { error: "Previous run was not finalized" });
        state.currentRootSpan = undefined;
      }
      if (state.currentEventId) {
        await eventShipper.finish(state.currentEventRequestId ?? state.currentEventId, {
          userId: getUserId(state, config.eventMetadata),
          properties: { sdk_version: libraryVersion, incomplete: true },
        });
        state.currentEventRequestId = undefined;
        state.currentEventId = undefined;
      }

      state.toolSpanStarts.clear();
      state.toolCallToLlmParent.clear();
      // Capped so a multi-MB prompt can't produce span attributes / events
      // that the ingest API rejects (silent data loss).
      state.currentInput = capText(event.prompt);
      state.turnNumber = 0;
      state.currentSystemPrompt = config.captureSystemPrompt
        ? truncateSystemPrompt(event.systemPrompt)
        : undefined;
      state.currentEventRequestId = generateId();
      state.totalInputTokens = 0;
      state.totalOutputTokens = 0;
      state.totalCacheReadTokens = 0;

      const attachments: Attachment[] =
        event.images?.map((image: { mimeType: string; data: string }, index: number) => ({
          type: "image" as const,
          role: "input" as const,
          name: `image-${index + 1}.${image.mimeType.split("/")[1]?.split("+")[0] ?? "png"}`,
          value: `data:${image.mimeType};base64,${image.data}`,
        })) ?? [];

      await eventShipper.patch(state.currentEventRequestId, {
        isPending: true,
        userId: getUserId(state, config.eventMetadata),
        convoId: state.sessionId,
        eventName: getEventName(config),
        input: state.currentInput,
        ...(attachments.length > 0 ? { attachments } : {}),
        properties: getBaseProperties(config, ctx),
      });
      await eventShipper.flush();

      state.currentEventId = state.currentEventRequestId;

      state.currentRootSpan = traceShipper.startSpan({
        name: "ai.event",
        eventId: state.currentEventId,
        attributes: [
          attrString("ai.operationId", "ai.event"),
          attrString("ai.prompt", truncate(state.currentInput)!),
          attrString("workspace", ctx.cwd),
          attrString("hostname", getHostname()),
          attrString("os", process.platform),
          attrString("username", getUsername()),
        ],
      });
    } catch (err) {
      logError("before_agent_start", err);
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    try {
      const state = getState(stateRef, ctx);
      startTurnSpan(state);
    } catch (err) {
      logError("turn_start", err);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const state = getState(stateRef, ctx);
      if (!state.currentTurnSpan) return;
      traceShipper.endSpan(state.currentTurnSpan);
      state.currentTurnSpan = undefined;
    } catch (err) {
      logError("turn_end", err);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    try {
      if ((event as any).message?.role !== "assistant") return;

      const state = getState(stateRef, ctx);
      if (!state.currentEventId || !state.currentRootSpan) return;
      ensureTurnSpan(state);

      const message = (event as any).message;
      const provider = message.provider ?? "";
      const modelId = message.model ?? "";
      const modelName = provider && modelId ? `${provider}/${modelId}` : modelId || "llm";
      const errorForSpan = getAssistantError(message);
      const outputText = capText(getAssistantText(message));

      const inputTokens = message.usage?.input;
      const outputTokens = message.usage?.output;
      const cacheReadTokens =
        typeof message.usage?.cacheRead === "number" ? message.usage.cacheRead : 0;
      const cacheWriteTokens =
        typeof message.usage?.cacheWrite === "number" ? message.usage.cacheWrite : 0;

      // Accumulate token usage for event properties
      if (typeof inputTokens === "number") state.totalInputTokens += inputTokens;
      if (typeof outputTokens === "number") state.totalOutputTokens += outputTokens;
      if (cacheReadTokens > 0) state.totalCacheReadTokens += cacheReadTokens;

      const turnParent = state.currentTurnSpan ?? state.currentRootSpan;

      // Create LLM span as child of current turn
      const llmAttrs: Array<OtlpKeyValue | undefined> = [
        attrString("ai.operationId", "generateText"),
        provider ? attrString("gen_ai.system", provider) : undefined,
        modelId ? attrString("gen_ai.request.model", modelId) : undefined,
        modelId ? attrString("gen_ai.response.model", modelId) : undefined,
        ...modelSpendSpanAttributes({
          provider: provider || undefined,
          usage:
            typeof inputTokens === "number" && typeof outputTokens === "number"
              ? {
                  input: inputTokens,
                  output: outputTokens,
                  cacheRead: cacheReadTokens,
                  cacheWrite: cacheWriteTokens,
                }
              : undefined,
        }),
        outputText ? attrString("ai.response.text", truncate(outputText)!) : undefined,
        state.currentInput ? attrString("ai.prompt", truncate(state.currentInput)!) : undefined,
        message.stopReason ? attrString("ai.stop_reason", message.stopReason) : undefined,
        ...getSystemPromptAttributes(state.currentSystemPrompt),
      ].filter(Boolean) as OtlpKeyValue[];

      const llmSpan = traceShipper.startSpan({
        name: modelName,
        parent: turnParent.ids,
        eventId: state.currentEventId,
        attributes: llmAttrs,
      });
      traceShipper.endSpan(llmSpan, errorForSpan ? { error: errorForSpan } : undefined);

      // Map tool call IDs to this LLM span for nesting
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part && typeof part === "object" && part.type === "toolCall" && typeof part.id === "string") {
            state.toolCallToLlmParent.set(part.id, llmSpan.ids);
          }
        }
      }

      if (message.stopReason === "toolUse") {
        // Keep turn open for tool execution + next LLM call
        await traceShipper.flush();
        return;
      }

      // Final assistant response — close the turn
      if (state.currentTurnSpan) {
        traceShipper.endSpan(state.currentTurnSpan);
        state.currentTurnSpan = undefined;
      }

      // Close root span
      state.currentRootSpan.name = modelName;
      traceShipper.endSpan(state.currentRootSpan, {
        attributes: [
          ...(outputText ? [attrString("ai.response.text", truncate(outputText)!)] : []),
          ...(state.totalInputTokens > 0
            ? [attrInt("raindrop.run.total_input_tokens", state.totalInputTokens)]
            : []),
          ...(state.totalOutputTokens > 0
            ? [attrInt("raindrop.run.total_output_tokens", state.totalOutputTokens)]
            : []),
          ...(state.totalCacheReadTokens > 0
            ? [attrInt("raindrop.run.total_cache_read_tokens", state.totalCacheReadTokens)]
            : []),
          attrInt("ai.total_turns", state.turnNumber),
        ],
        ...(errorForSpan ? { error: errorForSpan } : {}),
      });
      state.currentRootSpan = undefined;

      // Finalize event
      await eventShipper.finish(state.currentEventRequestId ?? state.currentEventId, {
        userId: getUserId(state, config.eventMetadata),
        ...(modelId ? { model: modelId } : {}),
        ...(!errorForSpan && outputText.trim() ? { output: outputText } : {}),
        usage: {
          promptTokens: state.totalInputTokens > 0 ? state.totalInputTokens : undefined,
          completionTokens:
            state.totalOutputTokens > 0 ? state.totalOutputTokens : undefined,
        },
        error: errorForSpan,
        properties: {
          sdk_version: libraryVersion,
          stop_reason: message.stopReason,
          ...(provider ? { "ai.provider": provider } : {}),
          ...(state.totalCacheReadTokens > 0
            ? { "ai.usage.cache_read_tokens": state.totalCacheReadTokens }
            : {}),
        },
      });

      state.currentEventRequestId = undefined;
      state.currentEventId = undefined;
      state.toolSpanStarts.clear();
      state.toolCallToLlmParent.clear();

      await traceShipper.flush();
    } catch (err) {
      logError("message_end", err);
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      const state = getState(stateRef, ctx);
      if (!state.currentEventId || !state.currentRootSpan) return;

      // Parent to LLM span that requested this tool, else turn, else root
      const llmParent = state.toolCallToLlmParent.get(event.toolCallId);
      const parent = llmParent ?? state.currentTurnSpan?.ids ?? state.currentRootSpan.ids;

      state.toolSpanStarts.set(event.toolCallId, {
        startTimeUnixNano: nowUnixNanoString(),
        parent,
        eventId: state.currentEventId,
        name: event.toolName,
        args: safeStringify(event.args) ?? "{}",
      });
    } catch (err) {
      logError("tool_execution_start", err);
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      const state = getState(stateRef, ctx);
      const start = state.toolSpanStarts.get(event.toolCallId);
      if (!start) return;

      state.toolSpanStarts.delete(event.toolCallId);
      state.toolCallToLlmParent.delete(event.toolCallId);

      const resultStr = safeStringify(event.result);

      traceShipper.createSpan({
        name: formatToolSpanName(start.name, safeParsArgs(start.args)),
        parent: start.parent,
        eventId: start.eventId,
        startTimeUnixNano: start.startTimeUnixNano,
        endTimeUnixNano: nowUnixNanoString(),
        attributes: [
          attrString("ai.operationId", "ai.toolCall"),
          attrString("ai.toolCall.name", start.name),
          attrString("ai.toolCall.id", event.toolCallId),
          attrString("ai.toolCall.args", truncate(start.args)!),
          ...(resultStr ? [attrString("ai.toolCall.result", truncate(resultStr)!)] : []),
        ],
        ...(event.isError
          ? { status: { code: 2, message: `Tool "${start.name}" failed` } }
          : {}),
      });
    } catch (err) {
      logError("tool_execution_end", err);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      const state = getState(stateRef, ctx);

      if (state.currentTurnSpan) {
        traceShipper.endSpan(state.currentTurnSpan);
        state.currentTurnSpan = undefined;
      }

      if (state.currentRootSpan) {
        traceShipper.endSpan(state.currentRootSpan, {
          error: "Agent ended before a final assistant response was recorded",
        });
        state.currentRootSpan = undefined;
      }

      if (state.currentEventId) {
        await eventShipper.finish(state.currentEventRequestId ?? state.currentEventId, {
          userId: getUserId(state, config.eventMetadata),
          properties: {
            sdk_version: libraryVersion,
            incomplete: true,
          },
        });
        state.currentEventRequestId = undefined;
        state.currentEventId = undefined;
      }

      state.toolSpanStarts.clear();
      state.toolCallToLlmParent.clear();
      await Promise.all([eventShipper.flush(), traceShipper.flush()]);
    } catch (err) {
      logError("agent_end", err);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      stateRef.current = undefined;
      await Promise.all([eventShipper.shutdown(), traceShipper.shutdown()]);
    } catch (err) {
      logError("session_shutdown", err);
    } finally {
      try {
        onShutdown?.();
      } catch {
        // Optional metadata cleanup must not affect the host lifecycle.
      }
    }
  });
}
