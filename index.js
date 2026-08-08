import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — allows a browser page (like the test tool) to call this service.
// Must run before the auth check, and must let OPTIONS preflight requests
// through without requiring the API key (browsers send these automatically
// and don't attach custom headers to them).
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// AUTH — require a shared secret so this deployed URL can't be hit (and
// billed) by anyone who finds it. Retool will send this as a header when
// it calls this service. Set API_KEY in .env and keep it out of git.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const provided = req.header('x-api-key');
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// Mirrors the scope we set for the Wellington Ops Agent inside Retool:
// Simpro Wellington data only, no other franchise, no financial advice.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the Wellington Ops Agent for Kiwiseal's franchisor
Business Hub. You only answer questions about the Wellington franchise's job
status, scheduling, invoicing, purchase orders, and profitability, using data
from the Simpro Wellington API. Do not reference or infer data from Auckland,
Bay of Plenty, or any other franchise or resource — you have no access to them.

For purchase order and job value questions, treat these as franchisor-level
compliance metrics: purchase order value indicates whether product is actually
being bought for a job, and total job value is the basis the franchise fee is
calculated from. Always present these two figures together, not separately,
and note the variance between them when relevant.

Give direct, concise, numbers-first answers. If a tool call fails or returns
incomplete data, say so plainly rather than guessing.`;

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS — same five tools scoped in the Retool build.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'getJobStatus',
    description: 'Returns job stage/status for a given job number or filter, from Simpro Wellington.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string', description: 'Specific Simpro job number, if known' },
        filter: { type: 'string', description: 'Free-text filter, e.g. "active jobs", "jobs in progress"' }
      }
    }
  },
  {
    name: 'getSchedulingGaps',
    description: 'Returns Wellington jobs that are not yet booked in / have scheduling gaps.',
    input_schema: {
      type: 'object',
      properties: {
        withinDays: { type: 'number', description: 'Optional lookahead window in days' }
      }
    }
  },
  {
    name: 'getInvoiceStatus',
    description: 'Returns invoiced vs outstanding amounts for a given job or date range in Wellington.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' },
        dateFrom: { type: 'string', description: 'ISO date' },
        dateTo: { type: 'string', description: 'ISO date' }
      }
    }
  },
  {
    name: 'getJobPnl',
    description: 'Returns cost breakdown, margin %, and cost-vs-sell for a given Wellington job.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' }
      },
      required: ['jobNumber']
    }
  },
  {
    name: 'getJobPurchaseOrders',
    description:
      'Returns, per job: total PO value (all time), total job/contract value (franchise fee basis), ' +
      'and PO value as a % of job value. Full history by default — only filters by date if asked.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' },
        dateFrom: { type: 'string', description: 'Only set if the user explicitly asked to filter by date' },
        dateTo: { type: 'string' }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// SIMPRO API CLIENT
// Confirmed real endpoint, taken directly from Retool's working getJobsReal
// query: companies/{COMPANY_ID}/jobs/, paginated. Company ID and the
// status → stage mapping below are copied from that same source so this
// agent's numbers agree with what the Hub already shows.
// ---------------------------------------------------------------------------
const COMPANY_ID = 5;

// Status ID → stage mapping for Wellington (matches Retool's getJobsReal)
const STATUS_STAGE_MAP = {
  692: 'needs-attention',   // 5-Needs Organizing
  691: 'needs-attention',   // 4-Variation Pending Deposit
  688: 'active',            // 3-VIP Job Section
  1431: 'active',           // 6-Scheduled
  804: 'active',            // 7-Remedial Works Commenced
  1332: 'active',           // 8-Remedial Completed - Pending install
  690: 'active',            // 9-Coating Works in Progress
  1202: 'active',           // 12-Snags List In Progress
  673: 'awaiting-payment',  // 1-Sales Invoice Issued
  771: 'awaiting-payment',  // 10-Practical Completion – Final Invoice Sent
  1464: 'awaiting-payment', // 11-Post QA Complete - Waiting Final Payment
  1365: 'awaiting-payment', // 13-Snag List Complete-Waiting Full Payment
  652: 'complete',          // 16-Fully Paid – Archived
  681: 'excluded',          // 15-Warranty Works
  654: 'excluded',          // 17-On Hold
  653: 'excluded'           // 18-Cancelled / Duplicate / Archive
};

async function simproRequest(path, params = {}) {
  if (!process.env.SIMPRO_BEARER_TOKEN) {
    throw new Error('SIMPRO_BEARER_TOKEN not configured');
  }
  const base = process.env.SIMPRO_BASE_URL.endsWith('/')
    ? process.env.SIMPRO_BASE_URL
    : process.env.SIMPRO_BASE_URL + '/';
  const cleanPath = path.replace(/^\/+/, '');
  const url = new URL(cleanPath, base);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.SIMPRO_BEARER_TOKEN}`,
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Simpro API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Fetches every job for this company, paginated, same shape as Retool's
// fetchAllJobs. Other tools (invoices, PnL, purchase orders) still need
// their own confirmed endpoints — this only covers job status/scheduling.
async function fetchAllJobs() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${COMPANY_ID}/jobs/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Status,Type,Total,DateIssued,DueDate,Site,Customer,Name'
    });
    // Simpro's jobs endpoint returns a bare array, not {data: [...]} — handle
    // both shapes defensively in case that ever changes.
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

function shapeJob(j) {
  const statusId = j.Status?.ID ?? 0;
  const stage = STATUS_STAGE_MAP[statusId] ?? 'active';
  const customer = j.Customer?.CompanyName
    || `${j.Customer?.GivenName ?? ''} ${j.Customer?.FamilyName ?? ''}`.trim()
    || 'Unknown';
  return {
    id: j.ID,
    name: j.Name ?? `Job #${j.ID}`,
    statusName: (j.Status?.Name ?? 'Unknown').trim(),
    stage,
    customer,
    siteAddress: j.Site?.Name ?? '',
    totalIncTax: j.Total?.IncTax ?? 0,
    dateIssued: j.DateIssued ?? '',
    dueDate: j.DueDate ?? ''
  };
}

const toolImplementations = {
  async getJobStatus({ jobNumber, filter }) {
    const jobs = (await fetchAllJobs())
      .filter((j) => STATUS_STAGE_MAP[j.Status?.ID] !== 'excluded')
      .map(shapeJob);

    if (jobNumber) {
      const match = jobs.find((j) => String(j.id) === String(jobNumber));
      return match ? { job: match } : { error: `No job found with number ${jobNumber}` };
    }

    if (filter) {
      const needle = filter.toLowerCase();
      const matches = jobs.filter(
        (j) => j.name.toLowerCase().includes(needle) || j.stage.includes(needle) || j.customer.toLowerCase().includes(needle)
      );
      return { count: matches.length, jobs: matches.slice(0, 25) };
    }

    return { count: jobs.length, jobs: jobs.slice(0, 25) };
  },

  async getSchedulingGaps() {
    const jobs = (await fetchAllJobs())
      .filter((j) => STATUS_STAGE_MAP[j.Status?.ID] === 'needs-attention')
      .map(shapeJob);

    return {
      count: jobs.length,
      totalValue: jobs.reduce((s, j) => s + j.totalIncTax, 0),
      jobs
    };
  },

  async getInvoiceStatus({ jobNumber, dateFrom, dateTo }) {
    // TODO: not yet wired to a confirmed Simpro endpoint — check Retool's
    // getInvoices query for the real path, same way we found getJobsReal's.
    throw new Error('getInvoiceStatus not yet implemented — endpoint not confirmed');
  },

  async getJobPnl({ jobNumber }) {
    // TODO: not yet wired to a confirmed Simpro endpoint.
    throw new Error('getJobPnl not yet implemented — endpoint not confirmed');
  },

  async getJobPurchaseOrders({ jobNumber, dateFrom, dateTo }) {
    // TODO: not yet wired to a confirmed Simpro endpoint — check Retool's
    // getPurchaseOrders query for the real path.
    throw new Error('getJobPurchaseOrders not yet implemented — endpoint not confirmed');
  }
};

// ---------------------------------------------------------------------------
// AGENT LOOP
// ---------------------------------------------------------------------------
async function runAgent(userMessage, conversationHistory = []) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];

  while (true) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === 'text');
      return { reply: textBlock?.text ?? '', messages: [...messages, { role: 'assistant', content: response.content }] };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        const impl = toolImplementations[block.name];
        if (!impl) throw new Error(`No implementation for tool ${block.name}`);
        result = await impl(block.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result)
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

// ---------------------------------------------------------------------------
// HTTP ENDPOINT
// ---------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message, conversationHistory } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const result = await runAgent(message, conversationHistory);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wellington Ops Agent listening on :${port}`));
