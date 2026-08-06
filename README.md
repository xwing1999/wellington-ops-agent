# Wellington Ops Agent (standalone)

Ports the "Wellington Ops Agent" built in Retool's Agent builder into a plain
Node.js service calling the Claude API directly — no Retool AI credits
involved. Retool can still be the dashboard UI; it just calls this service's
`/chat` endpoint instead of running its own Agent.

## Why this exists

The Retool-built version was consuming AI credits unpredictably (one tool
addition cost ~NZD $180). This service replaces that build with the same
agent behaviour — same system prompt, same five tools, same Simpro Wellington
scope — but billed directly by Anthropic per token, with full visibility into
what each call costs. See https://docs.claude.com/en/docs/about-claude/pricing
for current per-model rates before estimating monthly cost.

## What's implemented vs. stubbed

- Claude API tool-use loop: **done** (`runAgent` in `index.js`)
- Tool schemas for all 5 tools: **done**, matches the Retool build
  (`getJobStatus`, `getSchedulingGaps`, `getInvoiceStatus`, `getJobPnl`,
  `getJobPurchaseOrders`)
- Actual Simpro API calls: **stubbed** — `getSimproToken()` and the endpoint
  paths in `toolImplementations` need the real Simpro Wellington API auth
  flow and paths. Fastest way to get these: open the "Simpro Wellington API"
  resource in Retool and copy its base URL, auth method, and the query paths
  Assist already generated for the equivalent tools — no need to reverse
  Simpro's docs from scratch if Retool's queries are already working.

## Setup

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY and Simpro credentials
npm install
npm start
```

Test it:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the PO value vs job value for job 10921?"}'
```

## Deployment

Any Node-capable host works — this has no Retool dependency. Options roughly
in order of simplicity: a small VPS, a container on Railway/Render/Fly.io, or
AWS Lambda behind API Gateway if serverless is preferred (would need minor
adaptation from the Express server to a handler function).

## Wiring back into the Retool Hub

Once deployed, add a plain REST API resource in Retool pointing at this
service's `/chat` endpoint, and have the Business Brain panel (or a new UI
component) call it instead of a Retool-native Agent. This keeps Retool as the
dashboard/UI layer only — no Retool Agent credits, no Retool Agent runtime
hours.

## Extending to other franchises

Same pattern for Auckland/BOP: copy this service, swap the system prompt and
tool set to Pipely Auckland / Pipely - BOP, deploy separately (or as one
service with multiple agent configs). The orchestrator agent can then be a
thin layer that calls each of these services as its own "tools" and
synthesizes across them — no need to rebuild that logic in Retool at all.
