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
    description: 'Returns invoiced vs outstanding amounts and per-invoice detail for a given job or date range in Wellington.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' },
        dateFrom: { type: 'string', description: 'ISO date, filters by DateIssued' },
        dateTo: { type: 'string', description: 'ISO date, filters by DateIssued' }
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

// ---------------------------------------------------------------------------
// Confirmed real endpoints for invoices / purchase orders (called
// "vendorOrders" in Simpro's own API) / job P&L. Found the same way the
// jobs endpoint was found originally: matched Retool's own native code
// against the live API, verified with real Wellington data before porting.
// Two path quirks that don't follow the jobs-collection pattern:
//   - Single job detail (`jobs/{id}`) takes NO trailing slash — the
//     opposite of the collection endpoints below, which all need one.
//   - Purchase orders are "vendorOrders" in Simpro, not "purchaseOrders".
// ---------------------------------------------------------------------------
async function fetchAllInvoices() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${COMPANY_ID}/invoices/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Type,Customer,Jobs,Total,IsPaid,DateIssued,Status'
    });
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function fetchAllVendorOrders() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${COMPANY_ID}/vendorOrders/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Stage,Reference,Totals,AssignedTo,DateIssued'
    });
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// ---------------------------------------------------------------------------
// CUSTOMER LOOKUP — NOT YET CONFIRMED against live Wellington data, unlike
// everything above. Simpro splits customers into two separate collections
// (business vs individual) in its documented API — companies/{ID}/customers
// /companies/ and /individuals/ — this mirrors that, but exactly like the
// vendorOrders-vs-purchaseOrders guess earlier, the real path/columns need
// verifying against a live call before this is trusted. First real call IS
// the test.
// ---------------------------------------------------------------------------
async function fetchCustomers(type) {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${COMPANY_ID}/customers/${type}/`, {
      pageSize: '100',
      page: String(page),
      columns: type === 'companies'
        ? 'ID,CompanyName,Email,Phone,CellPhone'
        : 'ID,GivenName,FamilyName,Email,CellPhone,WorkPhone'
    });
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// Compares the last 8 digits only, to dodge +64/0/spacing formatting
// differences between how Pipely and Simpro store the same phone number.
function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : digits || null;
}

async function findCustomersByContact({ phone, email }) {
  const [companies, individuals] = await Promise.all([
    fetchCustomers('companies'),
    fetchCustomers('individuals')
  ]);
  const all = [...companies, ...individuals];

  const normTarget = normalizePhone(phone);
  const emailTarget = email ? String(email).trim().toLowerCase() : null;

  return all.filter((c) => {
    const candidatePhones = [c.Phone, c.CellPhone, c.WorkPhone].filter(Boolean).map(normalizePhone);
    const candidateEmail = c.Email ? String(c.Email).trim().toLowerCase() : null;
    const phoneMatch = normTarget && candidatePhones.includes(normTarget);
    const emailMatch = emailTarget && candidateEmail === emailTarget;
    return phoneMatch || emailMatch;
  }).map((c) => ({
    id: c.ID,
    name: c.CompanyName || `${c.GivenName ?? ''} ${c.FamilyName ?? ''}`.trim() || 'Unknown',
    matchedOn: normTarget && [c.Phone, c.CellPhone, c.WorkPhone].filter(Boolean).map(normalizePhone).includes(normTarget) ? 'phone' : 'email'
  }));
}

// Batch, non-chat lookup — deliberately bypasses the Claude/tool loop.
// Business Brain needs to join potentially dozens of Pipely deals against
// Simpro customer records; routing that through natural-language questions
// one deal at a time would be slow and burn tokens for what is really a
// deterministic join. This does the join in code and returns structured
// JSON directly.
async function lookupByContact(contacts) {
  const results = [];
  for (const { phone, email } of contacts) {
    const matchedCustomers = await findCustomersByContact({ phone, email });
    if (!matchedCustomers.length) {
      results.push({ phone: phone ?? null, email: email ?? null, matched: false });
      continue;
    }
    const customerIds = matchedCustomers.map((c) => c.id);
    const [jobs, invoices] = await Promise.all([fetchAllJobs(), fetchAllInvoices()]);
    const matchedJobs = jobs.filter((j) => customerIds.includes(j.Customer?.ID)).map(shapeJob);
    const matchedInvoices = invoices.filter((inv) => customerIds.includes(inv.Customer?.ID));
    const earliestPaidInvoice = matchedInvoices
      .filter((inv) => inv.IsPaid)
      .sort((a, b) => (a.DateIssued ?? '').localeCompare(b.DateIssued ?? ''))[0] ?? null;

    results.push({
      phone: phone ?? null,
      email: email ?? null,
      matched: true,
      matchedOn: matchedCustomers[0].matchedOn,
      customers: matchedCustomers,
      jobs: matchedJobs,
      earliestPaidInvoice: earliestPaidInvoice ? {
        invoiceId: earliestPaidInvoice.ID,
        dateIssued: earliestPaidInvoice.DateIssued ?? '',
        totalIncTax: earliestPaidInvoice.Total?.IncTax ?? 0,
        jobIds: (earliestPaidInvoice.Jobs || []).map((j) => j.ID)
      } : null
    });
  }
  return results;
}

function pnlHealth(marginPct) {
  if (marginPct >= 60) return 'strong';
  if (marginPct >= 40) return 'ok';
  if (marginPct >= 0) return 'tight';
  return 'loss';
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
    let invoices = await fetchAllInvoices();

    if (jobNumber) {
      invoices = invoices.filter((inv) => (inv.Jobs || []).some((j) => String(j.ID) === String(jobNumber)));
    }
    if (dateFrom) invoices = invoices.filter((inv) => (inv.DateIssued ?? '') >= dateFrom);
    if (dateTo) invoices = invoices.filter((inv) => (inv.DateIssued ?? '') <= dateTo);

    const shaped = invoices.map((inv) => ({
      invoiceId: inv.ID,
      type: inv.Type,
      customer: inv.Customer?.CompanyName
        || `${inv.Customer?.GivenName ?? ''} ${inv.Customer?.FamilyName ?? ''}`.trim()
        || 'Unknown',
      jobIds: (inv.Jobs || []).map((j) => j.ID),
      statusName: inv.Status?.Name ?? 'Unknown',
      dateIssued: inv.DateIssued ?? '',
      totalIncTax: inv.Total?.IncTax ?? 0,
      balanceDue: inv.Total?.BalanceDue ?? 0,
      isPaid: inv.IsPaid ?? false
    }));

    return {
      count: shaped.length,
      totalInvoiced: shaped.reduce((s, i) => s + i.totalIncTax, 0),
      totalOutstanding: shaped.reduce((s, i) => s + i.balanceDue, 0),
      totalPaid: shaped.filter((i) => i.isPaid).reduce((s, i) => s + i.totalIncTax, 0),
      invoices: shaped.slice(0, 25)
    };
  },

  async getJobPnl({ jobNumber }) {
    const j = await simproRequest(`companies/${COMPANY_ID}/jobs/${jobNumber}`, {
      columns: 'ID,Name,Stage,Status,Customer,Total,Totals,DateIssued'
    });

    const exTax = j.Total?.ExTax ?? 0;
    const gp = j.Totals?.GrossProfitLoss?.Actual ?? 0;
    const margin = j.Totals?.GrossMargin?.Actual ?? (exTax > 0 ? Math.round((gp / exTax) * 10000) / 100 : 0);
    const matActual = j.Totals?.MaterialsCost?.Actual ?? 0;
    const matCommitted = j.Totals?.MaterialsCost?.Committed ?? 0;
    const labourActual = j.Totals?.ResourcesCost?.Labor?.Actual ?? 0;
    const totalCostsActual = (j.Totals?.ResourcesCost?.Total?.Actual ?? 0) + matActual;
    const costPct = exTax > 0 ? Math.round((totalCostsActual / exTax) * 100) : 0;

    return {
      jobId: String(j.ID),
      customer: j.Customer?.CompanyName
        || `${j.Customer?.GivenName ?? ''} ${j.Customer?.FamilyName ?? ''}`.trim()
        || 'Unknown',
      stage: j.Stage ?? '',
      statusName: j.Status?.Name ?? '',
      dateIssued: j.DateIssued ?? '',
      contractExTax: exTax,
      contractIncTax: j.Total?.IncTax ?? 0,
      grossProfitActual: gp,
      grossMarginPct: margin,
      materialsCostActual: matActual,
      materialsCostCommitted: matCommitted,
      labourCostActual: labourActual,
      totalCostsActual,
      costPctOfSell: `${costPct}% of sell price`,
      health: pnlHealth(margin)
    };
  },

  async getJobPurchaseOrders({ jobNumber, dateFrom, dateTo }) {
    let orders = await fetchAllVendorOrders();

    if (jobNumber) orders = orders.filter((po) => String(po.AssignedTo?.Job) === String(jobNumber));
    if (dateFrom) orders = orders.filter((po) => (po.DateIssued ?? '') >= dateFrom);
    if (dateTo) orders = orders.filter((po) => (po.DateIssued ?? '') <= dateTo);

    const shaped = orders.map((po) => ({
      poId: po.ID,
      jobId: po.AssignedTo?.Job ?? null,
      stage: po.Stage,
      reference: po.Reference,
      totalExTax: po.Totals?.ExTax ?? 0,
      totalIncTax: po.Totals?.IncTax ?? 0,
      dateIssued: po.DateIssued ?? ''
    }));

    const totalPoValue = shaped.reduce((s, p) => s + p.totalIncTax, 0);

    let jobContractValue = null;
    let poPctOfJobValue = null;
    if (jobNumber) {
      try {
        const job = await simproRequest(`companies/${COMPANY_ID}/jobs/${jobNumber}`, { columns: 'ID,Total' });
        jobContractValue = job.Total?.IncTax ?? null;
        if (jobContractValue) poPctOfJobValue = Math.round((totalPoValue / jobContractValue) * 1000) / 10;
      } catch (e) {
        // Job lookup failed — leave the comparison out rather than guessing.
      }
    }

    return {
      count: shaped.length,
      totalPoValue,
      jobContractValue,
      poPctOfJobValue,
      orders: shaped.slice(0, 25)
    };
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

// Structured, non-chat endpoint for Business Brain's cross-system matching —
// see lookupByContact() above for why this bypasses the Claude/tool loop.
app.post('/lookup-by-contact', async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts (array of {phone, email}) is required' });
  }
  try {
    const results = await lookupByContact(contacts);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Wellington Ops Agent listening on :${port}`));
