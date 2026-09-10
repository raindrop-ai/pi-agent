import {
  EventShipper as CoreEventShipper,
  TraceShipper as CoreTraceShipper,
  type OtlpSpan,
} from "@raindrop-ai/core";

import { libraryName, libraryVersion } from "../version";

export type { OtlpKeyValue, OtlpSpan, InternalSpan, SpanIds, Attachment } from "@raindrop-ai/core";

export {
  MODEL_USAGE_ATTRIBUTES,
  attrString,
  attrInt,
  buildRawModelUsageAttributes,
  canonicalModelProvider,
  nowUnixNanoString,
  randomUUID,
  generateId,
} from "@raindrop-ai/core";

export class EventShipper extends CoreEventShipper {
  constructor(opts: ConstructorParameters<typeof CoreEventShipper>[0]) {
    super({
      ...opts,
      sdkName: opts.sdkName ?? "pi-agent",
      libraryName: opts.libraryName ?? libraryName,
      libraryVersion: opts.libraryVersion ?? libraryVersion,
      defaultEventName: opts.defaultEventName ?? "pi_agent_prompt",
    });
  }
}

export class TraceShipper extends CoreTraceShipper {
  constructor(opts: ConstructorParameters<typeof CoreTraceShipper>[0]) {
    super({
      ...opts,
      sdkName: opts.sdkName ?? "pi-agent",
      serviceName: opts.serviceName ?? "raindrop.pi-agent",
      serviceVersion: opts.serviceVersion ?? libraryVersion,
    });
  }

  override enqueue(span: OtlpSpan): void {
    const attrs = span.attributes ?? [];
    attrs.unshift(
      { key: "span.id", value: { stringValue: span.spanId } },
      ...(span.parentSpanId
        ? [{ key: "span.parent.id", value: { stringValue: span.parentSpanId } }]
        : []),
    );
    span.attributes = attrs;
    super.enqueue(span);
  }
}
