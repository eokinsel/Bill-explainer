const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ANTHROPIC_API_KEY: CONFIG_API_KEY } = require("./config");
const db = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || CONFIG_API_KEY;

const MODEL = "claude-opus-4-8";
const SYSTEM_PROMPT = `You are a billing explainer assistant. The user will upload a photo or text of a bill — medical, insurance, utility, or other. They may also provide a summary of their insurance plan's coverage details, and a summary of their bills from last month for comparison.

Your job is to:
1. Identify what type of bill it is and who the provider (the company or entity issuing the bill) is
2. Break down each charge in plain, simple English
3. If — and only if — the user provided details about their insurance plan, assess whether the charges are likely covered, partially covered, or not covered by that plan. Reference specific plan terms (deductible, copay, coinsurance, network status, exclusions) where relevant, and be honest about uncertainty rather than guessing confidently. If no insurance plan details were provided, skip this entirely.
4. Flag anything that looks unusual, duplicated, or genuinely worth questioning
5. Give a one-line summary of what they actually owe and why
6. If — and only if — something is genuinely inconsistent (duplicate charges, math errors, charges for services not received, mismatched dates/codes, amounts that contradict insurance EOB language, etc.) and worth disputing, draft a short, polite, factual message the person can send to the biller disputing it. Reference the specific line items and amounts. Do not invent a dispute if nothing is actually wrong — vague or minor items that are simply "worth asking about" do not warrant a dispute letter, only the "Worth double-checking" section.
7. If — and only if — the user provided a summary of last month's bills and one of them is from the same provider and the same type of bill as the one you're now explaining, compare the two: note whether the amount owed went up or down and by how much (with a percentage if useful), call out any charges that appear to be new, missing, or changed in price compared to last month's summary, and note any shift in the due date. If none of last month's bills match this one by both provider and bill type, skip this entirely — do not guess at a comparison from an unrelated provider or bill type.

Be clear and friendly. Avoid jargon. If something is unclear in the bill, say so honestly rather than guessing.

Format your response in this structure using markdown headers (##):
## What kind of bill this is
## Charge breakdown
## Insurance coverage likelihood
## What changed since last bill
## Worth double-checking
## Bottom line
## Dispute letter

Only include the "Insurance coverage likelihood" section if the user provided insurance plan details; otherwise omit it entirely — do not include it with placeholder or "no insurance info provided" text. Only include the "What changed since last bill" section if step 7 applies; otherwise omit it entirely — do not include it with placeholder or "no prior bill to compare" text. Only include the "Dispute letter" section if step 6 applies. If there's nothing worth disputing, omit that section entirely — do not include it with placeholder or "nothing to dispute" text.

After all of the above, end your response with exactly one fenced code block tagged json containing the bill's category, the provider name, the total amount owed, the disputed amount, and the payment due date. "category" must be exactly one of: "Medical", "Insurance", "Utility", "Other". "provider" must be the name of the company or entity issuing the bill (e.g. "Pacific Gas & Electric", "Kaiser Permanente"), as best identified from the bill; use your best judgment if it isn't explicitly labeled. "amountOwed" must be a plain number (no currency symbol, no commas) — your best reading of the total the person owes; use your best estimate if the bill doesn't state it outright. "disputedAmount" must be a plain number representing the specific dollar amount being disputed in the dispute letter, or 0 if no dispute letter was written. "dueDate" must be the payment due date as an ISO date string ("YYYY-MM-DD") if clearly stated on the bill, or null if not found. Example:
\`\`\`json
{"category": "Medical", "provider": "Kaiser Permanente", "amountOwed": 128.50, "disputedAmount": 45.00, "dueDate": "2026-08-15"}
\`\`\``;

const INSURANCE_EXTRACT_PROMPT = `You are an assistant that reads insurance plan documents (text, photos, or PDFs of them) and extracts the key coverage facts a person needs to know when checking whether a medical bill is covered. Summarize in clear plain text: deductible (individual/family), copay and coinsurance amounts, in-network vs out-of-network differences, annual out-of-pocket maximum, and anything explicitly excluded or requiring prior authorization. Be concise and factual — do not add commentary or disclaimers. If the provided content doesn't look like an insurance plan document, say so plainly instead of guessing.`;

const PORT = process.env.PORT || 4173;

async function callClaude({ system, content, maxTokens }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return { error: data?.error?.message || `Request failed (${response.status})` };
  }

  const textBlock = (data.content || []).find((b) => b.type === "text");
  return { text: textBlock ? textBlock.text : "No response received." };
}

// Bills from the calendar month immediately before `now`, used to let the
// model compare a new bill against a same-provider bill from last month.
function lastMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return { start, end };
}

function buildLastMonthContext(history) {
  const { start, end } = lastMonthRange();
  const entries = history.filter((h) => h.provider && h.date >= start && h.date < end);
  if (!entries.length) return null;
  return entries.map((h) =>
    `Provider: ${h.provider}\nCategory: ${h.category}\nAmount: $${h.amount}\nDate: ${h.date.slice(0, 10)}\nSummary: ${(h.explanation || h.billSnippet || "").slice(0, 600)}`
  ).join("\n\n");
}

async function explainBill({ text, imageBase64, imageMediaType, insurancePlanText, userId }) {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.includes("PUT-YOUR-KEY-HERE")) {
    return { error: "This app hasn't been set up with an API key yet. Edit config.js." };
  }

  const content = [];
  if (insurancePlanText && insurancePlanText.trim()) {
    content.push({
      type: "text",
      text: `Here are the relevant details of my insurance plan, for assessing coverage:\n\n${insurancePlanText.trim()}`
    });
  }
  if (userId) {
    const lastMonthContext = buildLastMonthContext(db.getHistory(userId));
    if (lastMonthContext) {
      content.push({
        type: "text",
        text: `Here is a summary of my bills from last month, for comparison purposes only:\n\n${lastMonthContext}`
      });
    }
  }
  if (imageBase64) {
    if (imageMediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: imageBase64 }
      });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: imageMediaType, data: imageBase64 }
      });
    }
  }
  content.push({
    type: "text",
    text: text || "Here is my bill. Please explain it."
  });

  try {
    return await callClaude({ system: SYSTEM_PROMPT, content, maxTokens: 4096 });
  } catch (err) {
    return { error: err.message || "Something went wrong." };
  }
}

async function extractInsurancePlan({ text, imageBase64, imageMediaType }) {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.includes("PUT-YOUR-KEY-HERE")) {
    return { error: "This app hasn't been set up with an API key yet. Edit config.js." };
  }

  const content = [];
  if (imageBase64) {
    if (imageMediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: imageBase64 }
      });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: imageMediaType, data: imageBase64 }
      });
    }
  }
  content.push({
    type: "text",
    text: text || "Here is my insurance plan document."
  });

  try {
    return await callClaude({ system: INSURANCE_EXTRACT_PROMPT, content, maxTokens: 1024 });
  } catch (err) {
    return { error: err.message || "Something went wrong." };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function getAuthUserId(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return db.verifyToken(token);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && req.url === "/api/explain") {
    const userId = getAuthUserId(req);
    try {
      const body = JSON.parse(await readBody(req));
      const result = await explainBill({ ...body, userId });
      if (!result.error && userId) {
        const match = result.text && result.text.match(/```json\s*([\s\S]*?)```\s*$/i);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            const CATS = ["Medical", "Insurance", "Utility", "Other"];
            if (CATS.includes(parsed.category) && typeof parsed.amountOwed === "number") {
              const cleanText = result.text.slice(0, match.index).trim();
              const billSnippet = (body.text || "").slice(0, 200).trim();
              const disputedAmount = typeof parsed.disputedAmount === "number" ? parsed.disputedAmount : 0;
              const provider = typeof parsed.provider === "string" ? parsed.provider.trim().slice(0, 200) : null;
              db.addHistoryEntry(userId, parsed.category, parsed.amountOwed, cleanText, billSnippet, disputedAmount, provider);
            }
          } catch { /* ignore */ }
        }
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/signup") {
    try {
      const { username, email, password } = JSON.parse(await readBody(req));
      const user = db.createUser({ username, email, password });
      const token = db.createToken(user.id);
      sendJson(res, 200, { token, username: user.username });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/login") {
    try {
      const { identifier, password } = JSON.parse(await readBody(req));
      const user = db.verifyUser({ identifier, password });
      const token = db.createToken(user.id);
      sendJson(res, 200, { token, username: user.username });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/me") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    const user = db.getUserById(userId);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    sendJson(res, 200, { username: user.username, email: user.email });
    return;
  }

  if (req.method === "GET" && req.url === "/api/history") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    sendJson(res, 200, { history: db.getHistory(userId) });
    return;
  }

  if (req.method === "POST" && req.url === "/api/history") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    try {
      const { category, amount, explanation, billSnippet, disputedAmount, provider } = JSON.parse(await readBody(req));
      db.addHistoryEntry(userId, category, amount, explanation || null, billSnippet || null, disputedAmount || 0, provider || null);
      sendJson(res, 200, { history: db.getHistory(userId) });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/history/reset") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    db.resetHistory(userId);
    sendJson(res, 200, { history: [] });
    return;
  }

  if (req.method === "GET" && req.url === "/api/insurance") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    sendJson(res, 200, { text: db.getInsurancePlan(userId) });
    return;
  }

  if (req.method === "POST" && req.url === "/api/insurance") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    try {
      const { text } = JSON.parse(await readBody(req));
      db.setInsurancePlan(userId, text || "");
      sendJson(res, 200, { text: text || "" });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/avatar") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    sendJson(res, 200, { dataUrl: db.getAvatar(userId) });
    return;
  }

  if (req.method === "POST" && req.url === "/api/avatar") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJson(res, 401, { error: "Not logged in" });
    try {
      const { dataUrl } = JSON.parse(await readBody(req));
      db.setAvatar(userId, dataUrl || "");
      sendJson(res, 200, { dataUrl: dataUrl || "" });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/insurance/extract") {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await extractInsurancePlan(body);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Bad request" });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/leaderboard") {
    sendJson(res, 200, { leaderboard: db.getLeaderboard() });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLanIp();
  console.log(`Bill Explainer running.`);
  console.log(`  On this Mac:  http://localhost:${PORT}`);
  console.log(`  On your phone (same WiFi): http://${ip}:${PORT}`);
});
