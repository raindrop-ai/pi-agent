import type { Agent } from "@earendil-works/pi-agent-core";
import { resolveLocalDebuggerBaseUrl } from "@raindrop-ai/core";
import { EventShipper, TraceShipper } from "./internal/shipper";
import { createSubscriber } from "./internal/subscriber";
import type {
  Attachment,
  PiAgentSubscribeOptions,
  RaindropPiAgentClient,
  RaindropPiAgentOptions,
} from "./types";

export type {
  Attachment,
  PiAgentSubscribeOptions,
  RaindropPiAgentClient,
  RaindropPiAgentOptions,
};

function envDebugEnabled(): boolean {
  if (typeof process === "undefined") return false;
  const flag = process.env?.RAINDROP_AI_DEBUG;
  return flag === "1" || flag === "true";
}

/**
 * Create a Raindrop Pi Agent client for automatic telemetry capture.
 *
 * @example
 * ```typescript
 * import { Agent } from "@earendil-works/pi-agent-core";
 * import { createRaindropPiAgent } from "@raindrop-ai/pi-agent";
 *
 * const raindrop = createRaindropPiAgent({
 *   writeKey: "your-write-key",
 *   userId: "user-123",
 *   convoId: "session-abc",
 * });
 *
 * const agent = new Agent({ ... });
 * const unsub = raindrop.subscribe(agent);
 *
 * await agent.prompt("Hello!");
 * await raindrop.shutdown();
 * ```
 */
export function createRaindropPiAgent(
  opts: RaindropPiAgentOptions,
): RaindropPiAgentClient {
  const hasWriteKey = typeof opts.writeKey === "string" && opts.writeKey.trim().length > 0;
  // Resolve here so the env / auto-detect signals also gate shipper construction
  // (otherwise local-only mode requires an explicit localWorkshopUrl ctor option).
  const resolvedLocalUrl = resolveLocalDebuggerBaseUrl(opts.localWorkshopUrl);
  const hasLocalDestination = resolvedLocalUrl !== null;
  const eventsEnabled = opts.events?.enabled !== false;
  const tracesEnabled = opts.traces?.enabled !== false;

  if (!hasWriteKey && !opts.endpoint && !hasLocalDestination) {
    console.warn(
      "[raindrop-ai/pi-agent] writeKey not provided; telemetry shipping is disabled",
    );
  }

  const envDebug = envDebugEnabled();
  const debug = opts.events?.debug === true || opts.traces?.debug === true || envDebug;

  const eventShipper =
    eventsEnabled && (hasWriteKey || opts.endpoint || hasLocalDestination)
      ? new EventShipper({
          writeKey: opts.writeKey,
          endpoint: opts.endpoint,
          enabled: true,
          debug: opts.events?.debug === true || envDebug,
          partialFlushMs: opts.events?.partialFlushMs,
          projectId: opts.projectId,
          localDebuggerUrl: opts.localWorkshopUrl,
          maxTextFieldChars: opts.maxTextFieldChars,
        })
      : null;

  const traceShipper =
    tracesEnabled && (hasWriteKey || opts.endpoint || hasLocalDestination)
      ? new TraceShipper({
          writeKey: opts.writeKey,
          endpoint: opts.endpoint,
          enabled: true,
          debug: opts.traces?.debug === true || envDebug,
          debugSpans: opts.traces?.debugSpans === true || envDebug,
          flushIntervalMs: opts.traces?.flushIntervalMs,
          maxBatchSize: opts.traces?.maxBatchSize,
          maxQueueSize: opts.traces?.maxQueueSize,
          projectId: opts.projectId,
          localDebuggerUrl: opts.localWorkshopUrl,
          maxTextFieldChars: opts.maxTextFieldChars,
        })
      : null;

  const defaultOptions = {
    userId: opts.userId,
    convoId: opts.convoId,
    eventName: opts.eventName,
    eventId: opts.eventId,
    properties: opts.properties,
  };

  return {
    subscribe(agent: Agent, options?: PiAgentSubscribeOptions): () => void {
      return createSubscriber(
        agent,
        eventShipper,
        traceShipper,
        defaultOptions,
        options ?? {},
        debug,
        opts.maxTextFieldChars,
      );
    },

    events: {
      async patch(eventId: string, data: Record<string, unknown>) {
        if (!eventShipper) return;
        await eventShipper.patch(eventId, data);
      },

      async addAttachments(eventId: string, attachments: Attachment[]) {
        if (!eventShipper) return;
        await eventShipper.patch(eventId, { attachments });
      },

      async setProperties(eventId: string, properties: Record<string, unknown>) {
        if (!eventShipper) return;
        await eventShipper.patch(eventId, { properties });
      },

      async finish(eventId: string) {
        if (!eventShipper) return;
        await eventShipper.finish(eventId, {});
      },
    },

    users: {
      async identify(params: { userId: string; traits?: Record<string, unknown> }) {
        if (!eventShipper) return;
        await eventShipper.identify([
          { userId: params.userId, traits: params.traits ?? {} },
        ]);
      },
    },

    signals: {
      async track(params: {
        eventId?: string;
        name: string;
        type?: "default" | "feedback" | "edit";
        sentiment?: "POSITIVE" | "NEGATIVE";
        timestamp?: string;
        attachmentId?: string;
        comment?: string;
        after?: string;
        [key: string]: unknown;
      }) {
        if (!eventShipper) return;
        if (!params.name || !params.name.trim()) {
          console.warn("[raindrop-ai/pi-agent] signal name is required");
          return;
        }
        const {
          eventId,
          name,
          type,
          sentiment,
          timestamp,
          attachmentId,
          comment,
          after,
          ...otherProperties
        } = params;
        await eventShipper.trackSignal({
          eventId: eventId ?? "",
          name,
          type,
          sentiment,
          timestamp,
          attachmentId,
          comment,
          after,
          properties: otherProperties,
        });
      },
    },

    async flush() {
      await Promise.all([
        eventShipper?.flush() ?? Promise.resolve(),
        traceShipper?.flush() ?? Promise.resolve(),
      ]);
    },

    async shutdown() {
      await Promise.all([
        eventShipper?.shutdown() ?? Promise.resolve(),
        traceShipper?.shutdown() ?? Promise.resolve(),
      ]);
    },
  };
}
