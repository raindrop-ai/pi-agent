> **Read-only mirror.** This repository is an automated export of the
> `@raindrop-ai/pi-agent` package source from Raindrop's SDK monorepo, published
> alongside each npm release; tag `vX.Y.Z` matches `@raindrop-ai/pi-agent@X.Y.Z`
> on npm. It depends on `@raindrop-ai/core`, an internal workspace package
> that is bundled into the npm tarball at build time and not published on its
> own, so this mirror is for reading rather than building. Pull requests and
> issues are not accepted here. For support see
> https://www.raindrop.ai/docs/support/; for security reports see
> [SECURITY.md](./SECURITY.md).

# @raindrop-ai/pi-agent

Automatic observability for [Pi Agent](https://github.com/earendil-works/pi) with [Raindrop](https://raindrop.ai). Captures agent runs, LLM generations, tool calls, and token usage.

Two entry points:

- **`@raindrop-ai/pi-agent`** — programmatic subscriber for `pi-agent-core` users
- **`@raindrop-ai/pi-agent/extension`** — pi-coding-agent CLI extension (auto-discovered via `pi install`)

Requires Pi **0.84.4 or later** and Node.js **22.19.0 or later**, matching Pi's runtime requirement. This requirement applies to the Pi integration, not other Raindrop SDKs.

## Quick Start — Programmatic

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRaindropPiAgent } from "@raindrop-ai/pi-agent";

const raindrop = createRaindropPiAgent({
  writeKey: "your-write-key",
  userId: "user-123",
});

const models = createModels();
models.setProvider(openaiProvider());
const model = models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("Model unavailable");

const agent = new Agent({
  streamFn: models.streamSimple,
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
});

raindrop.subscribe(agent);
await agent.prompt("Hello!");
await raindrop.shutdown();
```

## Quick Start — Pi Coding Agent CLI

```bash
pi install npm:@raindrop-ai/pi-agent
```

Set `RAINDROP_WRITE_KEY` in your environment. Traces appear automatically.

## Projects

If your org has multiple projects, route events to a specific one by passing its slug as `projectId` programmatically:

```typescript
const raindrop = createRaindropPiAgent({
  writeKey: "your-write-key",
  projectId: "support-prod",
});
```

For the CLI extension, set the slug via the `RAINDROP_PROJECT_ID` env var (or the `project_id` config-file key). Either way this sets the `X-Raindrop-Project-Id` header on every event. Omit it (or use `"default"`) to use your org's default **Production** project — the existing behavior. Single-project orgs need nothing new.

## Model context and tool results

Programmatic subscriptions capture the system prompt, messages, and tools after
Pi applies `transformContext`. Model spans start before the provider call and
include reasoning and tool calls. Tool spans contain the result's `details` when
provided, or its `content`; failed tools retain their error content.

For agents that finish by committing a result through a tool, provide an output
reader. It runs at completion and cannot interrupt the agent if it throws:

```typescript
raindrop.subscribe(agent, {
  runName: "Simulate lookup",
  getOutput: () => JSON.stringify(committedResult),
});
```

## Payload size limits

Programmatic event and span text fields default to **1,000,000 characters**.
Set `maxTextFieldChars` on `createRaindropPiAgent` to use a different positive
limit across the subscriber and both shippers. For full capture of large replay
payloads, use `Number.MAX_SAFE_INTEGER`; transport and ingest limits still apply.
The CLI extension retains its existing event and span limits.

## Documentation

See the full [Pi Agent docs](https://www.raindrop.ai/docs/integrations/pi-agent/) for configuration, per-subscribe overrides, and extension settings.

## License

MIT
