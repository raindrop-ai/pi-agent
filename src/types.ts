import type { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "./internal/shipper";

export type { Attachment };

/**
 * Options for the Raindrop Pi Agent client.
 */
export interface RaindropPiAgentOptions {
  /**
   * Write key for direct authentication.
   * Optional — when omitted, telemetry shipping is disabled with a warning.
   */
  writeKey?: string;
  /** API endpoint URL (defaults to production) */
  endpoint?: string;
  /**
   * Optional Raindrop project slug. When set, every outbound cloud request
   * carries an `X-Raindrop-Project-Id` header. Unset → no header (the project
   * resolves to `default` server-side; byte-identical to prior behavior).
   */
  projectId?: string;
  /** Default user ID for all events */
  userId?: string;
  /** Default conversation ID to group related events */
  convoId?: string;
  /** Default event name (default: "pi_agent_prompt") */
  eventName?: string;
  /**
   * Per-run event id source. Invoked once per agent run to mint that run's
   * event id (reused for the run's Raindrop event and every linked span). A
   * static string is intentionally not accepted: a long-lived client runs many
   * agent runs, and a fixed id would collide across them. Absent / throwing /
   * non-string / empty results fall back to a random UUID, so a caller's id
   * source never crashes telemetry.
   */
  eventId?: () => string;
  /** Default properties attached to every event */
  properties?: Record<string, unknown>;
  /**
   * Explicit Workshop / local debugger URL forwarded to both shippers as
   * their `localDebuggerUrl`. `null` opts out (overrides
   * `RAINDROP_LOCAL_DEBUGGER` / `RAINDROP_WORKSHOP` env vars and
   * auto-detect). `undefined` falls through to the env / auto-detect
   * resolution in `@raindrop-ai/core`.
   */
  localWorkshopUrl?: string | null;
  /** Maximum characters per captured text field (default: 1,000,000). */
  maxTextFieldChars?: number;
  /** Trace shipping configuration */
  traces?: {
    /** Enable trace shipping (default: true) */
    enabled?: boolean;
    /** Flush interval in milliseconds */
    flushIntervalMs?: number;
    /** Maximum batch size */
    maxBatchSize?: number;
    /** Maximum queue size */
    maxQueueSize?: number;
    /** Enable debug logging */
    debug?: boolean;
    /** Enable detailed span logging */
    debugSpans?: boolean;
  };
  /** Event shipping configuration */
  events?: {
    /** Enable event shipping (default: true) */
    enabled?: boolean;
    /** Partial flush interval in milliseconds */
    partialFlushMs?: number;
    /** Enable debug logging */
    debug?: boolean;
  };
}

/**
 * Per-subscribe overrides for context.
 */
export interface PiAgentSubscribeOptions {
  /** Human-readable name for the root operation span. */
  runName?: string;
  /** Read the completed result when an agent finishes through a tool instead of text. */
  getOutput?: () => string | undefined;
  /** User ID override for this subscription */
  userId?: string;
  /** Conversation ID override */
  convoId?: string;
  /** Event name override */
  eventName?: string;
  /** Per-run event id source override (see RaindropPiAgentOptions.eventId) */
  eventId?: () => string;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * The Raindrop Pi Agent client.
 * Exposes the full API surface: subscribe, events, users, signals, flush, shutdown.
 */
export interface RaindropPiAgentClient {
  /**
   * Subscribe to a Pi Agent instance for automatic telemetry.
   * Returns an unsubscribe function.
   *
   * @param agent - The Pi Agent instance to observe
   * @param options - Optional per-subscription overrides
   * @returns Unsubscribe function to stop tracking
   */
  subscribe(agent: Agent, options?: PiAgentSubscribeOptions): () => void;

  /** Event management methods */
  events: {
    /** Patch an existing event with additional data */
    patch(eventId: string, data: Record<string, unknown>): Promise<void>;
    /** Add attachments to an event */
    addAttachments(eventId: string, attachments: Attachment[]): Promise<void>;
    /** Set properties on an event */
    setProperties(eventId: string, properties: Record<string, unknown>): Promise<void>;
    /** Finish an event (trigger immediate shipping) */
    finish(eventId: string): Promise<void>;
  };

  /** User identification methods */
  users: {
    /** Identify a user with traits */
    identify(params: { userId: string; traits?: Record<string, unknown> }): Promise<void>;
  };

  /** Signal tracking methods */
  signals: {
    /** Track a signal (feedback, user action, etc.) */
    track(params: {
      eventId?: string;
      name: string;
      type?: "default" | "feedback" | "edit";
      sentiment?: "POSITIVE" | "NEGATIVE";
      timestamp?: string;
      attachmentId?: string;
      comment?: string;
      after?: string;
      [key: string]: unknown;
    }): Promise<void>;
  };

  /** Flush all pending events and traces */
  flush(): Promise<void>;

  /** Shutdown the client, flushing all data */
  shutdown(): Promise<void>;
}
