import type { Agent, AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { InternalSpan, OtlpKeyValue } from "./shipper";
import { attrString, attrInt, randomUUID } from "./shipper";
import type { EventShipper, TraceShipper } from "./shipper";
import {
  capText,
  extractUserText,
  extractModelName,
  extractTokenUsage,
  extractAssistantText,
  extractToolCallIds,
  safeStringify,
  formatToolSpanName,
  serializeModelContext,
  getUsername,
  getHostname,
  modelSpendSpanAttributes,
} from "./helpers";
import { libraryVersion } from "../version";
import type { PiAgentSubscribeOptions } from "../types";
import { resolveMaxTextFieldChars } from "@raindrop-ai/core";

/** attr helpers return undefined for missing values; keep OtlpKeyValue[] pushes type-safe. */
function pushAttr(attrs: OtlpKeyValue[], attr: OtlpKeyValue | undefined): void {
  if (attr) attrs.push(attr);
}

/**
 * Mint a run's event id from the caller-supplied per-run source, or a random
 * UUID when it is absent / throws / yields a non-string or empty value.
 * Telemetry must never crash the agent run, so a throwing source degrades to a
 * fresh UUID rather than propagating.
 */
function resolveEventId(source?: () => string): string {
  if (typeof source !== "function") return randomUUID();
  try {
    const id = source();
    return typeof id === "string" && id.trim() !== "" ? id : randomUUID();
  } catch {
    return randomUUID();
  }
}

interface RunState {
  eventId: string;
  rootSpan?: InternalSpan;
  currentInput: string;
  currentLlmSpan?: InternalSpan;
  outputParts: string[];
  currentTurnSpan?: InternalSpan;
  toolSpans: Map<string, InternalSpan>;
  toolArgs: Map<string, unknown>;
  toolCallToLlmSpan: Map<string, InternalSpan>;
  lastModel: string;
  lastProvider?: string;
  turnNumber: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  error?: Error;
}

// One dispatcher per agent lets subscriptions detach in any order without
// retaining inactive clients in a chain of stream wrappers.
const modelObservers = new WeakMap<Agent, {
  original: StreamFn;
  dispatch: StreamFn;
  listeners: Set<(...args: Parameters<StreamFn>) => void>;
}>();

function observeModel(agent: Agent, listener: (...args: Parameters<StreamFn>) => void): () => void {
  let entry = modelObservers.get(agent);
  if (!entry) {
    const original = agent.streamFunction;
    const listeners = new Set<(...args: Parameters<StreamFn>) => void>();
    const dispatch: StreamFn = (...args) => {
      for (const observer of listeners) observer(...args);
      return original.call(agent, ...args);
    };
    entry = { original, dispatch, listeners };
    modelObservers.set(agent, entry);
    agent.streamFunction = dispatch;
  }
  const subscription = entry;
  subscription.listeners.add(listener);
  return () => {
    subscription.listeners.delete(listener);
    if (subscription.listeners.size === 0) {
      if (agent.streamFunction === subscription.dispatch) agent.streamFunction = subscription.original;
      if (modelObservers.get(agent) === subscription) modelObservers.delete(agent);
    }
  };
}

/**
 * Subscribe to a Pi Agent instance and map lifecycle events to Raindrop
 * EventShipper / TraceShipper calls.
 *
 * Produces a 4-level trace hierarchy:
 *   Root -> Turn (ai.generate) -> LLM (model name) -> Tool (ai.toolCall)
 *
 * Returns an unsubscribe function.
 */
export function createSubscriber(
  agent: Agent,
  eventShipper: EventShipper | null,
  traceShipper: TraceShipper | null,
  defaultOptions: PiAgentSubscribeOptions,
  options: PiAgentSubscribeOptions,
  debug: boolean,
  maxTextFieldChars?: number,
): () => void {
  const textLimit = resolveMaxTextFieldChars(maxTextFieldChars);
  const userId = options.userId ?? defaultOptions.userId;
  const convoId = options.convoId ?? defaultOptions.convoId;
  const eventName = options.eventName ?? defaultOptions.eventName;
  const eventIdSource = options.eventId ?? defaultOptions.eventId;
  const properties = {
    ...(defaultOptions.properties ?? {}),
    ...(options.properties ?? {}),
  };

  let currentRun: RunState | undefined;

  const stopObservingModel = observeModel(agent, (model, context) => {
    try {
      if (currentRun && traceShipper && currentRun.currentTurnSpan) {
        currentRun.currentLlmSpan = traceShipper.startSpan({
          name: `${model.provider}/${model.id}`,
          parent: currentRun.currentTurnSpan.ids,
          eventId: currentRun.eventId,
          operationId: "generateText",
          attributes: [
            attrString("raindrop.span.kind", "llm_call"),
            attrString("ai.model.id", model.id),
            attrString("ai.prompt", serializeModelContext(context, textLimit)),
          ],
        });
      }
    } catch (err) {
      log(`Error capturing model context: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  function log(msg: string) {
    if (debug) console.log(`[raindrop-ai/pi-agent] ${msg}`);
  }

  function handleAgentStart(): void {
    try {
      // Clean up any lingering previous run (e.g., agent_start without prior agent_end)
      if (currentRun) {
        // Close children before parents per OTLP convention
        if (traceShipper) {
          if (currentRun.currentLlmSpan) traceShipper.endSpan(currentRun.currentLlmSpan);
          for (const [, span] of currentRun.toolSpans) {
            traceShipper.endSpan(span);
          }
        }
        if (currentRun.currentTurnSpan && traceShipper) {
          traceShipper.endSpan(currentRun.currentTurnSpan);
        }
        if (currentRun.rootSpan && traceShipper) {
          traceShipper.endSpan(currentRun.rootSpan, {
            error: "Previous run was not finalized",
          });
        }
        if (eventShipper) {
          eventShipper
            .finish(currentRun.eventId, {
              userId: userId ?? "anonymous",
              properties: { sdk_version: libraryVersion, incomplete: true },
            })
            .catch(() => {});
        }
        currentRun = undefined;
      }

      const eventId = resolveEventId(eventIdSource);
      const rootSpan = traceShipper
        ? traceShipper.startSpan({
            name: options.runName ?? eventName ?? "Pi Agent",
            operationId: "ai.agent",
            eventId,
            attributes: [
              attrString("raindrop.span.kind", "agent_root"),
              attrString("hostname", getHostname()),
              attrString("os", process.platform),
              attrString("username", getUsername()),
            ],
          })
        : undefined;

      currentRun = {
        eventId,
        rootSpan,
        currentInput: "",
        outputParts: [],
        toolSpans: new Map(),
        toolArgs: new Map(),
        toolCallToLlmSpan: new Map(),
        lastModel: "",
        turnNumber: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
      };

      if (eventShipper) {
        eventShipper
          .patch(eventId, {
            isPending: true,
            userId: userId ?? "anonymous",
            convoId,
            eventName,
            properties: {
              ...properties,
              sdk_version: libraryVersion,
              hostname: getHostname(),
              os: process.platform,
            },
          })
          .catch(() => {});
      }
    } catch (err) {
      log(`Error in agent_start handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleMessageEnd(message: AgentMessage): void {
    try {
      if (!currentRun) return;

      // Match the caller's text budget across event and span payloads.
      const userText = extractUserText(message);
      if (userText !== undefined) {
        // Steering and follow-ups belong to the model context, not the root request.
        if (currentRun.turnNumber > 1) return;
        const cappedInput = capText(userText, textLimit);
        currentRun.currentInput = cappedInput;
        if (eventShipper) {
          eventShipper
            .patch(currentRun.eventId, { input: cappedInput })
            .catch(() => {});
        }
        return;
      }

      // Handle assistant message: accumulate model/tokens + create LLM span
      if (!("role" in message) || message.role !== "assistant") return;

      const model = extractModelName(message);
      const provider =
        "provider" in message && typeof message.provider === "string" ? message.provider : undefined;
      const bareModel = typeof message.model === "string" ? message.model : undefined;
      const usage = extractTokenUsage(message);
      const assistantText = extractAssistantText(message);

      // Accumulate model/token data unconditionally (needed for events even when traces are disabled).
      // ai_data.model carries the bare model name; the provider ships separately as a property.
      // Provider and model come as a pair on each assistant message, so update them together —
      // this clears a previous provider when a later message reports a model without one.
      if (bareModel) {
        currentRun.lastModel = bareModel;
        currentRun.lastProvider = provider;
      }
      if (usage) {
        currentRun.totalInputTokens += usage.input;
        currentRun.totalOutputTokens += usage.output;
        if (usage.cacheRead > 0) currentRun.totalCacheReadTokens += usage.cacheRead;
      }

      // Span creation requires trace shipper and an active turn
      if (!traceShipper || !currentRun.currentTurnSpan) return;

      // Provider and bare model ID for GenAI semantic conventions (computed above).
      const rawProvider = provider;
      const rawModelId = bareModel;
      const stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;

      // Create an LLM span as child of the turn
      const llmAttrs: OtlpKeyValue[] = [];
      if (rawProvider) {
        pushAttr(llmAttrs, attrString("gen_ai.system", rawProvider));
      }
      if (rawModelId) {
        pushAttr(llmAttrs, attrString("gen_ai.response.model", rawModelId));
        pushAttr(llmAttrs, attrString("gen_ai.request.model", rawModelId));
      }
      llmAttrs.push(...modelSpendSpanAttributes({ provider: rawProvider, usage }));
      if (assistantText) {
        pushAttr(llmAttrs, attrString("ai.response.text", capText(assistantText, textLimit)));
      }
      const toolCalls = message.content.flatMap((block) => block.type === "toolCall"
        ? [{ toolCallId: block.id, toolName: block.name, input: block.arguments }]
        : []);
      if (toolCalls.length) {
        pushAttr(llmAttrs, attrString("ai.response.toolCalls", safeStringify(toolCalls, textLimit)));
      }
      const reasoning = message.content.flatMap((block) => block.type === "thinking" && !block.redacted
        ? [block.thinking] : []).join("\n");
      if (reasoning) pushAttr(llmAttrs, attrString("ai.response.reasoningText", capText(reasoning, textLimit)));
      if (stopReason) {
        pushAttr(llmAttrs, attrString("ai.stop_reason", stopReason));
      }

      const llmSpan = currentRun.currentLlmSpan ?? traceShipper.startSpan({
        name: model ?? "llm",
        parent: currentRun.currentTurnSpan.ids,
        eventId: currentRun.eventId,
        operationId: "generateText",
        attributes: [attrString("raindrop.span.kind", "llm_call")],
      });
      currentRun.currentLlmSpan = undefined;

      // End the LLM span with error status if the response was an error/abort
      const errorForSpan =
        stopReason === "error" || stopReason === "aborted"
          ? ("errorMessage" in message && typeof message.errorMessage === "string"
              ? message.errorMessage
              : `Assistant ${stopReason}`)
          : undefined;
      if (errorForSpan) {
        const assistantError = new Error(errorForSpan);
        assistantError.name =
          stopReason === "aborted" ? "AbortError" : "PiAgentError";
        currentRun.error = assistantError;
      } else {
        currentRun.error = undefined;
      }
      traceShipper.endSpan(llmSpan, { attributes: llmAttrs, error: errorForSpan });

      // Map tool call IDs from this assistant message to this LLM span
      const toolCallIds = extractToolCallIds(message);
      for (const tcId of toolCallIds) {
        currentRun.toolCallToLlmSpan.set(tcId, llmSpan);
      }
    } catch (err) {
      log(`Error in message_end handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    try {
      if (!currentRun) return;
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta" && "delta" in ame && typeof ame.delta === "string") {
        currentRun.outputParts.push(ame.delta);
      }
    } catch (err) {
      log(`Error in message_update handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleTurnStart(): void {
    try {
      if (!currentRun) return;
      currentRun.turnNumber += 1;

      // Reset output accumulator so only the final turn's text is captured
      currentRun.outputParts = [];
      if (currentRun.currentLlmSpan && traceShipper) {
        traceShipper.endSpan(currentRun.currentLlmSpan);
        currentRun.currentLlmSpan = undefined;
      }

      if (!traceShipper || !currentRun.rootSpan) return;

      // Close any leaked previous turn span
      if (currentRun.currentTurnSpan) {
        traceShipper.endSpan(currentRun.currentTurnSpan);
      }

      currentRun.currentTurnSpan = traceShipper.startSpan({
        name: `Turn ${currentRun.turnNumber}`,
        parent: currentRun.rootSpan.ids,
        eventId: currentRun.eventId,
        attributes: [
          attrString("ai.operationId", "ai.turn"),
          attrInt("ai.turn_number", currentRun.turnNumber),
        ],
      });
    } catch (err) {
      log(`Error in turn_start handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleTurnEnd(): void {
    try {
      if (!currentRun || !traceShipper || !currentRun.currentTurnSpan) return;

      traceShipper.endSpan(currentRun.currentTurnSpan);
      currentRun.currentTurnSpan = undefined;
    } catch (err) {
      log(`Error in turn_end handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleToolExecutionStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): void {
    try {
      if (!currentRun) return;

      currentRun.toolArgs.set(toolCallId, args);

      if (!traceShipper) return;

      // Parent to the LLM span that requested this tool call, else turn, else root
      const parentLlmSpan = currentRun.toolCallToLlmSpan.get(toolCallId);
      const parentSpan = parentLlmSpan ?? currentRun.currentTurnSpan ?? currentRun.rootSpan;
      if (!parentSpan) return;

      const toolSpan = traceShipper.startSpan({
        name: formatToolSpanName(toolName, args),
        parent: parentSpan.ids,
        eventId: currentRun.eventId,
        attributes: [
          attrString("raindrop.span.kind", "tool_call"),
          attrString("ai.operationId", "ai.toolCall"),
          attrString("ai.toolCall.name", toolName),
          attrString("ai.toolCall.id", toolCallId),
        ],
      });

      currentRun.toolSpans.set(toolCallId, toolSpan);
    } catch (err) {
      log(`Error in tool_execution_start handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleToolExecutionEnd(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    try {
      if (!currentRun) return;

      // Always clean up maps regardless of traceShipper state
      const toolSpan = currentRun.toolSpans.get(toolCallId);
      currentRun.toolSpans.delete(toolCallId);
      currentRun.toolCallToLlmSpan.delete(toolCallId);
      const args = currentRun.toolArgs.get(toolCallId);
      currentRun.toolArgs.delete(toolCallId);

      if (!traceShipper || !toolSpan) return;

      const endAttrs: OtlpKeyValue[] = [];
      const argsStr = safeStringify(args, textLimit);
      if (argsStr) pushAttr(endAttrs, attrString("ai.toolCall.args", argsStr));

      const resultStr = result === null ? "null" : safeStringify(result, textLimit);
      if (resultStr) pushAttr(endAttrs, attrString("ai.toolCall.result", resultStr));

      traceShipper.endSpan(toolSpan, {
        attributes: endAttrs,
        ...(isError
          ? { error: `Tool "${toolName}" failed` }
          : {}),
      });
    } catch (err) {
      log(`Error in tool_execution_end handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleAgentEnd(): void {
    try {
      if (!currentRun) return;

      const run = currentRun;
      currentRun = undefined;

      // Close children before parents per OTLP convention
      if (traceShipper) {
        if (run.currentLlmSpan) traceShipper.endSpan(run.currentLlmSpan);
        for (const [, span] of run.toolSpans) {
          traceShipper.endSpan(span);
        }
      }
      run.toolSpans.clear();
      run.toolCallToLlmSpan.clear();

      if (run.currentTurnSpan && traceShipper) {
        traceShipper.endSpan(run.currentTurnSpan);
        run.currentTurnSpan = undefined;
      }

      let outputText = capText(run.outputParts.join(""), textLimit);
      try {
        const output = options.getOutput?.();
        if (output !== undefined) outputText = capText(output, textLimit);
      } catch (err) {
        log(`Error reading operation output: ${err instanceof Error ? err.message : String(err)}`);
      }

      // End root span
      if (traceShipper && run.rootSpan) {
        const rootAttrs: OtlpKeyValue[] = [];
        if (run.currentInput) {
          pushAttr(rootAttrs, attrString("ai.prompt", run.currentInput));
        }
        if (outputText) {
          pushAttr(rootAttrs, attrString("ai.response.text", outputText));
        }
        if (run.totalInputTokens > 0) {
          pushAttr(rootAttrs, attrInt("raindrop.run.total_input_tokens", run.totalInputTokens));
        }
        if (run.totalOutputTokens > 0) {
          pushAttr(rootAttrs, attrInt("raindrop.run.total_output_tokens", run.totalOutputTokens));
        }
        if (run.totalCacheReadTokens > 0) {
          pushAttr(
            rootAttrs,
            attrInt("raindrop.run.total_cache_read_tokens", run.totalCacheReadTokens)
          );
        }
        pushAttr(rootAttrs, attrInt("ai.total_turns", run.turnNumber));

        traceShipper.endSpan(run.rootSpan, { attributes: rootAttrs });
      }

      // Finalize event
      if (eventShipper) {
        eventShipper
          .finish(run.eventId, {
            userId: userId ?? "anonymous",
            model: run.lastModel || undefined,
            output: run.error ? undefined : outputText || undefined,
            usage: {
              promptTokens: run.totalInputTokens > 0 ? run.totalInputTokens : undefined,
              completionTokens:
                run.totalOutputTokens > 0 ? run.totalOutputTokens : undefined,
            },
            error: run.error,
            properties: {
              ...properties,
              sdk_version: libraryVersion,
              ...(run.lastProvider ? { "ai.provider": run.lastProvider } : {}),
              ...(run.totalCacheReadTokens > 0
                ? { "ai.usage.cache_read_tokens": run.totalCacheReadTokens }
                : {}),
            },
          })
          .catch(() => {});
      }

      // Flush both shippers
      Promise.all([
        eventShipper?.flush(),
        traceShipper?.flush(),
      ]).catch(() => {});
    } catch (err) {
      log(`Error in agent_end handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    try {
      switch (event.type) {
        case "agent_start":
          handleAgentStart();
          break;
        case "message_end":
          handleMessageEnd(event.message);
          break;
        case "message_update":
          handleMessageUpdate(event);
          break;
        case "turn_start":
          handleTurnStart();
          break;
        case "turn_end":
          handleTurnEnd();
          break;
        case "tool_execution_start":
          handleToolExecutionStart(event.toolCallId, event.toolName, event.args);
          break;
        case "tool_execution_end":
          handleToolExecutionEnd(
            event.toolCallId,
            event.toolName,
            event.result,
            event.isError,
          );
          break;
        case "agent_end":
          handleAgentEnd();
          break;
      }
    } catch (err) {
      log(`Unhandled error in event handler: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return () => {
    unsubscribe();
    stopObservingModel();
  };
}
