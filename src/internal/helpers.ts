import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message, TextContent, ImageContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { hostname, userInfo } from "node:os";

import {
  MODEL_USAGE_ATTRIBUTES,
  type OtlpKeyValue,
  attrString,
  buildRawModelUsageAttributes,
  canonicalModelProvider,
} from "./shipper";

/**
 * Extract text content from a user message.
 * Only extracts user-role messages with no role prefix.
 */
export function extractUserText(message: AgentMessage): string | undefined {
  if (!("role" in message) || message.role !== "user") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/**
 * Extract the model name from an assistant message.
 */
export function extractModelName(message: AgentMessage): string | undefined {
  if (!("role" in message) || message.role !== "assistant") return undefined;
  const provider = "provider" in message ? message.provider : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  if (provider && model) return `${provider}/${model}`;
  return model;
}

/**
 * Extract token usage from an assistant message.
 * Pi Usage exposes input/output/cacheRead/cacheWrite (no reasoning field).
 */
export function extractTokenUsage(
  message: AgentMessage,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!("role" in message) || message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
  };
}

/**
 * Raw usage facts for an LLM span. Pi Usage.input is already exclusive of
 * cacheRead/cacheWrite across providers, so provenance lets Raindrop apply Pi's
 * source contract instead of the underlying provider's counter semantics.
 */
export function modelSpendSpanAttributes(input: {
  provider?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): OtlpKeyValue[] {
  const providerAttr = input.provider
    ? attrString("gen_ai.provider.name", canonicalModelProvider(input.provider))
    : undefined;
  const usageAttrs = input.usage
    ? buildRawModelUsageAttributes({
        inputTokens: input.usage.input,
        outputTokens: input.usage.output,
        cacheReadInputTokens: input.usage.cacheRead,
        cacheWriteInputTokens: input.usage.cacheWrite,
      })
    : [];
  return [
    providerAttr,
    attrString(MODEL_USAGE_ATTRIBUTES.usageSource, "pi-agent"),
    ...usageAttrs,
  ].filter((attribute): attribute is OtlpKeyValue => attribute !== undefined);
}

/**
 * Extract text content from an assistant message's content blocks.
 */
export function extractAssistantText(message: AgentMessage): string | undefined {
  if (!("role" in message) || message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const textParts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/**
 * Extract tool call IDs from an assistant message's content blocks.
 * Used to map tool calls to the LLM span that requested them.
 */
export function extractToolCallIds(message: AgentMessage): string[] {
  if (!("role" in message) || message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      ids.push(block.id);
    }
  }
  return ids;
}

/**
 * Format a descriptive tool span name: "tool_name: arg_preview"
 */
export function formatToolSpanName(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  try {
    const obj = args as Record<string, unknown>;
    const firstValue = Object.values(obj)[0];
    if (typeof firstValue === "string" && firstValue.length > 0) {
      const preview = firstValue.length > 40 ? firstValue.slice(0, 37) + "..." : firstValue;
      return `${toolName}: ${preview}`;
    }
  } catch {
    /* ignore */
  }
  return toolName;
}

/**
 * Truncation marker matching the Raindrop python-sdk (>= 0.0.51) so truncated
 * payloads carry a consistent signature across languages. Used for values
 * pruned inside a payload; `truncate()` keeps its legacy suffix for the
 * overall attribute string.
 */
export const TRUNCATION_MARKER = "...[truncated by raindrop]";

/**
 * Maximum characters for event-level text fields (ai input/output). Sized so
 * real customer fields in the 100k–1MB range round-trip intact while
 * pathological multi-MB payloads stay bounded: without a cap, a multi-MB
 * prompt or output pays its full serialization cost AND risks rejection at
 * the ingest size limit (silent data loss).
 */
export const MAX_TEXT_FIELD_CHARS = 1_000_000;

const MAX_ATTR_LENGTH = 32_768;

const MAX_BOUNDED_DEPTH = 12;

/**
 * Cap a raw text field BEFORE it enters the telemetry pipeline. The length
 * check is O(1), so multi-MB strings cost the cap, not the payload. The
 * result, marker included, never exceeds `limit`.
 */
export function capText(value: string, limit: number = MAX_TEXT_FIELD_CHARS): string {
  if (value.length <= limit) return value;
  if (limit > TRUNCATION_MARKER.length) {
    return value.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return value.slice(0, limit);
}

/**
 * Shallow-prune a payload to roughly `budget.remaining` characters of content,
 * so `JSON.stringify` of the clone is O(budget) regardless of payload shape.
 * Pi Agent runs in the host process: stringifying a multi-MB tool payload in
 * full just to truncate it to MAX_ATTR_LENGTH blocks the host's event loop
 * for the whole payload. String leaves are capped individually (a single
 * multi-MB string leaf never reaches the serializer) and every visited node
 * charges a little budget, bounding the walk itself on huge collections of
 * small values.
 *
 * `toJSON` is honored (like `JSON.stringify` does for Date etc.); functions,
 * symbols, undefined, and bigint pass through untouched so the final
 * `JSON.stringify` keeps its exact semantics for them.
 */
function boundedClone(value: unknown, budget: { remaining: number }, depth: number): unknown {
  if (budget.remaining <= 0) return TRUNCATION_MARKER;
  if (typeof value === "string") {
    if (value.length > budget.remaining) {
      const taken = value.slice(0, Math.max(0, budget.remaining)) + TRUNCATION_MARKER;
      budget.remaining = 0;
      return taken;
    }
    budget.remaining -= Math.max(value.length, 1);
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    budget.remaining -= 8;
    return value;
  }
  if (typeof value !== "object") {
    budget.remaining -= 8;
    return value;
  }
  if (depth >= MAX_BOUNDED_DEPTH) {
    budget.remaining -= 16;
    return `<max depth: ${TRUNCATION_MARKER}>`;
  }
  const withToJson = value as { toJSON?: (key?: string) => unknown };
  if (typeof withToJson.toJSON === "function") {
    try {
      return boundedClone(withToJson.toJSON(), budget, depth + 1);
    } catch {
      // Fall through to the generic walk below.
    }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) {
        out.push(TRUNCATION_MARKER);
        break;
      }
      out.push(boundedClone(item, budget, depth + 1));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (budget.remaining <= 0) {
      out["..."] = TRUNCATION_MARKER;
      break;
    }
    budget.remaining -= Math.max(key.length, 1);
    out[key] = boundedClone((value as Record<string, unknown>)[key], budget, depth + 1);
  }
  return out;
}

/**
 * Safely JSON.stringify a value, falling back to String() on failure.
 *
 * Bounded: the value is pruned to roughly `limit` characters BEFORE
 * serialization, so the cost is proportional to the cap, not the payload.
 * The default matches MAX_ATTR_LENGTH since every stringified payload feeds
 * a span attribute that `truncate()` caps at that size anyway.
 */
export function safeStringify(value: unknown, limit: number = MAX_ATTR_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const pruned = boundedClone(value, { remaining: limit + TRUNCATION_MARKER.length + 256 }, 0);
    return JSON.stringify(pruned);
  } catch {
    try {
      return capText(String(value), limit);
    } catch {
      return "[unserializable]";
    }
  }
}

export function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_ATTR_LENGTH) return value;
  const suffix = "\n...[truncated]";
  return value.slice(0, MAX_ATTR_LENGTH - suffix.length) + suffix;
}

let _hostname: string | undefined;
export function getHostname(): string {
  if (_hostname) return _hostname;
  try {
    _hostname = hostname();
  } catch {
    _hostname = process.env.HOSTNAME ?? "unknown";
  }
  return _hostname;
}

let _username: string | undefined;
export function getUsername(): string {
  if (_username) return _username;
  try {
    _username = userInfo().username;
  } catch {
    _username = process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
  return _username;
}

/** Budget the conversion itself, before allocating message copies or image URLs. */
export function serializeModelContext(context: Context, limit: number): string {
  // JSON syntax and escaping also use space. Halving the content budget keeps
  // total traversal bounded while leaving a complete document for the shipper.
  for (let contentLimit = limit; contentLimit > 0; contentLimit = Math.floor(contentLimit / 2)) {
    const budget = { remaining: contentLimit };
    const system = context.systemPrompt === undefined ? undefined : takeText(context.systemPrompt, budget);
    const messages: ReturnType<typeof modelMessage>[] = [];
    for (const message of context.messages) {
      if (budget.remaining <= 0) break;
      messages.push(modelMessage(message, budget));
    }
    const tools = context.tools === undefined ? undefined : boundedClone(context.tools, budget, 0);
    const serialized = JSON.stringify({
      system,
      messages,
      tools,
      truncated: contentLimit < limit || budget.remaining <= 0 ? TRUNCATION_MARKER : undefined,
    });
    if (serialized.length <= limit) return serialized;
  }
  const empty = JSON.stringify({ truncated: true });
  // Below 18 characters a labelled object cannot fit; still emit valid JSON.
  return empty.length <= limit ? empty : limit >= 2 ? "{}" : "0";
}

function takeText(text: string, budget: { remaining: number }): string {
  const result = capText(text, Math.max(0, budget.remaining));
  budget.remaining -= Math.max(result.length, 1);
  return result;
}

function modelBlock(block: TextContent | ImageContent | ThinkingContent | ToolCall, budget: { remaining: number }) {
  budget.remaining -= 16;
  switch (block.type) {
    case "text": return { type: "text", text: takeText(block.text, budget) };
    case "image": return { type: "image", image: takeText("data:", budget) + takeText(block.mimeType, budget) + takeText(";base64,", budget) + takeText(block.data, budget) };
    case "thinking": return { type: "reasoning", text: block.redacted ? "" : takeText(block.thinking, budget) };
    case "toolCall": return {
      type: "tool-call",
      toolCallId: takeText(block.id, budget),
      toolName: takeText(block.name, budget),
      input: boundedClone(block.arguments, budget, 0),
    };
  }
}

function modelMessage(message: Message, budget: { remaining: number }) {
  budget.remaining -= 16;
  const toolCallId = message.role === "toolResult" ? takeText(message.toolCallId, budget) : undefined;
  const toolName = message.role === "toolResult" ? takeText(message.toolName, budget) : undefined;
  const blocks: ReturnType<typeof modelBlock>[] = [];
  if (typeof message.content !== "string") {
    for (const block of message.content) {
      if (budget.remaining <= 0) {
        blocks.push({ type: "text", text: TRUNCATION_MARKER });
        break;
      }
      blocks.push(modelBlock(block, budget));
    }
  }
  const content = typeof message.content === "string" ? takeText(message.content, budget) : blocks;
  if (message.role === "toolResult") {
    return { role: "tool", toolCallId, toolName, isError: message.isError, content };
  }
  return { role: message.role, content };
}

/** Pi tool events contain a result envelope; errors carry their message in content. */
export function toolResultValue(result: unknown, isError: boolean): unknown {
  if (result === null || typeof result !== "object" || !("content" in result)) return result;
  if (!isError && "details" in result && result.details !== undefined) return result.details;
  return result.content;
}
