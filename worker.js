import Stripe from "stripe";

const MODEL = "claude-opus-4-8";
const CATEGORIES = ["Medical", "Insurance", "Utility", "Other"];

const FREE_YEARLY_LIMIT = 1;
const PREMIUM_PRICE_CENTS = 500;

// TEMP: premium disabled, everything is free for all users.
// Flip back to false (or delete this line) to restore the paywall — every
// premium check below funnels through isActiveStatus(), so that's the only
// thing that needs to change back.
const FORCE_ALL_PREMIUM = false;

const webCrypto = Stripe.createSubtleCryptoProvider();

function getStripe(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: "bill-app" }
  });
}
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

const BASIC_SYSTEM_PROMPT = `You are a billing explainer assistant. The user will upload a photo or text of a bill — medical, insurance, utility, or other.

Your job is to:
1. Identify what type of bill it is
2. Break down each charge in plain, simple English
3. Flag anything that looks unusual, duplicated, or genuinely worth questioning
4. Give a one-line summary of what they actually owe and why

Be clear and friendly. Avoid jargon. If something is unclear in the bill, say so honestly rather than guessing.

Format your response in this structure using markdown headers (##):
## What kind of bill this is
## Charge breakdown
## Worth double-checking
## Bottom line

Do not include an "Insurance coverage likelihood" section or a "Dispute letter" section — those are premium-only features. Do not end your response with a json code block.`;

const INSURANCE_EXTRACT_PROMPT = `You are an assistant that reads insurance plan documents (text, photos, or PDFs of them) and extracts the key coverage facts a person needs to know when checking whether a medical bill is covered. Summarize in clear plain text: deductible (individual/family), copay and coinsurance amounts, in-network vs out-of-network differences, annual out-of-pocket maximum, and anything explicitly excluded or requiring prior authorization. Be concise and factual — do not add commentary or disclaimers. If the provided content doesn't look like an insurance plan document, say so plainly instead of guessing.`;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS }
  });
}

// ---- crypto helpers (Web Crypto only — no Node "crypto" module in Workers) ----

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derived));
}

async function createToken(secret, userId) {
  const payload = JSON.stringify({ userId, exp: Date.now() + 1000 * 60 * 60 * 24 * 90 });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
}

async function verifyToken(secret, token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sig),
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

function getAuthUserId(request, secret) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(secret, token);
}

// Shared guard for premium-only routes (insurance, avatar, spending history).
// Returns { userId } on success, or { error: <Response> } to return directly.
async function requireSubscription(env, request) {
  const userId = await getAuthUserId(request, env.SESSION_SECRET);
  if (!userId) return { error: json(401, { error: "Not logged in" }) };
  const sub = await getSubscription(env.DB, userId);
  if (!isActiveStatus(sub.status)) {
    return {
      error: json(403, { error: "You need the Premium subscription to use this feature.", needsSubscription: true })
    };
  }
  return { userId };
}

// ---- account + history logic (D1-backed) ----

async function createUser(db, { username, email, password }) {
  username = (username || "").trim();
  email = (email || "").trim().toLowerCase();

  if (!username || !email || !password) {
    throw new Error("Username, email, and password are all required.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const existingUsername = await db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .bind(username)
    .first();
  if (existingUsername) throw new Error("That username is already taken.");

  const existingEmail = await db
    .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)")
    .bind(email)
    .first();
  if (existingEmail) throw new Error("That email is already registered.");

  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const passwordHash = await hashPassword(password, salt);
  const id = crypto.randomUUID();

  await db
    .prepare("INSERT INTO users (id, username, email, salt, password_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, username, email, salt, passwordHash)
    .run();

  return { id, username, email };
}

async function verifyUser(db, { identifier, password }) {
  identifier = (identifier || "").trim();
  const user = await db
    .prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)")
    .bind(identifier, identifier)
    .first();
  if (!user) throw new Error("No account found with that username or email.");

  const candidateHash = await hashPassword(password, user.salt);
  if (!timingSafeEqualHex(candidateHash, user.password_hash)) {
    throw new Error("Incorrect password.");
  }
  return user;
}

async function getUserById(db, id) {
  return db.prepare("SELECT id, username, email FROM users WHERE id = ?").bind(id).first();
}

async function getHistory(db, userId) {
  const { results } = await db
    .prepare("SELECT id, category, amount, date, explanation, bill_snippet, provider FROM history WHERE user_id = ? ORDER BY date DESC")
    .bind(userId)
    .all();
  return results.map(r => ({
    id: r.id, category: r.category, amount: r.amount, date: r.date,
    explanation: r.explanation || null, billSnippet: r.bill_snippet || null, provider: r.provider || null
  }));
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
  const entries = history.filter(h => h.provider && h.date >= start && h.date < end);
  if (!entries.length) return null;
  return entries.map(h =>
    `Provider: ${h.provider}\nCategory: ${h.category}\nAmount: $${h.amount}\nDate: ${h.date.slice(0, 10)}\nSummary: ${(h.explanation || h.billSnippet || "").slice(0, 600)}`
  ).join("\n\n");
}

async function addHistoryEntry(db, userId, category, amount, explanation, billSnippet, disputedAmount, provider) {
  await db
    .prepare("INSERT INTO history (id, user_id, category, amount, date, explanation, bill_snippet, disputed_amount, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, category, amount, new Date().toISOString(), explanation || null, billSnippet || null, disputedAmount || 0, provider || null)
    .run();
}

async function resetHistory(db, userId) {
  await db.prepare("DELETE FROM history WHERE user_id = ?").bind(userId).run();
}

async function getInsurancePlan(db, userId) {
  const row = await db.prepare("SELECT insurance_plan FROM users WHERE id = ?").bind(userId).first();
  return row ? row.insurance_plan || "" : "";
}

async function setInsurancePlan(db, userId, text) {
  await db.prepare("UPDATE users SET insurance_plan = ? WHERE id = ?").bind(text, userId).run();
}

async function getSubscription(db, userId) {
  const row = await db
    .prepare("SELECT subscription_status, subscription_period_end FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return row
    ? { status: row.subscription_status, periodEnd: row.subscription_period_end }
    : { status: "inactive", periodEnd: null };
}

function isActiveStatus(status) {
  return FORCE_ALL_PREMIUM || status === "active" || status === "trialing";
}

// Free usage resets each calendar year. Stored in the legacy `usage_month` column.
function currentUsageKey() {
  return String(new Date().getUTCFullYear());
}

async function getUsageCount(db, userId) {
  const row = await db.prepare("SELECT usage_month, usage_count FROM users WHERE id = ?").bind(userId).first();
  if (!row || row.usage_month !== currentUsageKey()) return 0;
  return row.usage_count;
}

// Consumes one of the free yearly summaries. Returns false if the yearly limit is already used.
async function consumeFreeUsage(db, userId) {
  const period = currentUsageKey();
  const row = await db.prepare("SELECT usage_month, usage_count FROM users WHERE id = ?").bind(userId).first();
  const count = row && row.usage_month === period ? row.usage_count : 0;
  if (count >= FREE_YEARLY_LIMIT) return false;
  await db.prepare("UPDATE users SET usage_month = ?, usage_count = ? WHERE id = ?").bind(period, count + 1, userId).run();
  return true;
}

async function refundFreeUsage(db, userId) {
  const period = currentUsageKey();
  const row = await db.prepare("SELECT usage_month, usage_count FROM users WHERE id = ?").bind(userId).first();
  if (row && row.usage_month === period && row.usage_count > 0) {
    await db.prepare("UPDATE users SET usage_count = ? WHERE id = ?").bind(row.usage_count - 1, userId).run();
  }
}

async function getAvatar(db, userId) {
  const row = await db.prepare("SELECT avatar FROM users WHERE id = ?").bind(userId).first();
  return row ? row.avatar || "" : "";
}

async function setAvatar(db, userId, dataUrl) {
  await db.prepare("UPDATE users SET avatar = ? WHERE id = ?").bind(dataUrl, userId).run();
}

// ---- bill explanation (Anthropic call) ----

async function callClaude(env, { system, content, maxTokens }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
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

async function explainBill(env, { text, imageBase64, imageMediaType, insurancePlanText, subscribed, userId }) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: "This app hasn't been set up with an API key yet." };
  }

  const content = [];
  if (subscribed && insurancePlanText && insurancePlanText.trim()) {
    content.push({
      type: "text",
      text: `Here are the relevant details of my insurance plan, for assessing coverage:\n\n${insurancePlanText.trim()}`
    });
  }
  if (subscribed && userId) {
    const lastMonthContext = buildLastMonthContext(await getHistory(env.DB, userId));
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
  content.push({ type: "text", text: text || "Here is my bill. Please explain it." });

  try {
    return await callClaude(env, { system: subscribed ? SYSTEM_PROMPT : BASIC_SYSTEM_PROMPT, content, maxTokens: 4096 });
  } catch (err) {
    return { error: err.message || "Something went wrong." };
  }
}

async function extractInsurancePlan(env, { text, imageBase64, imageMediaType }) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: "This app hasn't been set up with an API key yet." };
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
  content.push({ type: "text", text: text || "Here is my insurance plan document." });

  try {
    return await callClaude(env, { system: INSURANCE_EXTRACT_PROMPT, content, maxTokens: 1024 });
  } catch (err) {
    return { error: err.message || "Something went wrong." };
  }
}

async function createReminder(db, { userId, email, billLabel, amountOwed, dueDate, reminderDate }) {
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO reminders (id, user_id, email, bill_label, amount_owed, due_date, reminder_date) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, email, billLabel || null, amountOwed ?? null, dueDate || null, reminderDate).run();
  return { id };
}

async function getReminders(db, userId) {
  const { results } = await db.prepare(
    "SELECT id, bill_label, amount_owed, due_date, reminder_date, sent FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY reminder_date ASC"
  ).bind(userId).all();
  return results;
}

async function deleteReminder(db, id, userId) {
  await db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

async function sendReminderEmail(env, { to, billLabel, amountOwed, dueDate }) {
  if (!env.RESEND_API_KEY) return;
  const amount = amountOwed != null ? `$${Number(amountOwed).toFixed(2)}` : null;
  const label = billLabel || "a bill";
  const due = dueDate
    ? new Date(dueDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  const bodyLines = [`You asked us to remind you about <strong>${label}</strong>.`];
  if (amount) bodyLines.push(`Amount due: <strong>${amount}</strong>`);
  if (due) bodyLines.push(`Due date: <strong>${due}</strong>`);

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM || "Bill Explainer <reminders@billexplainer.app>",
      to: [to],
      subject: `Reminder: ${label}${due ? ` due ${due}` : ""}`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px">Payment reminder</h2>${bodyLines.map(l => `<p style="margin:4px 0">${l}</p>`).join("")}<p style="color:#888;font-size:12px;margin-top:24px">Sent by <a href="https://bill-app.edward-d7e.workers.dev">Bill Explainer</a>.</p></div>`
    })
  });
}

export default {
  async scheduled(_event, env) {
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      "SELECT r.*, u.email AS user_email FROM reminders r JOIN users u ON u.id = r.user_id WHERE r.reminder_date <= ? AND r.sent = 0"
    ).bind(today).all();
    for (const r of results) {
      try {
        await sendReminderEmail(env, {
          to: r.email || r.user_email,
          billLabel: r.bill_label,
          amountOwed: r.amount_owed,
          dueDate: r.due_date
        });
        await env.DB.prepare("UPDATE reminders SET sent = 1 WHERE id = ?").bind(r.id).run();
      } catch (e) {
        console.error("Reminder send failed:", r.id, e.message);
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/explain" && request.method === "POST") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Log in to explain a bill." });

      const subscription = await getSubscription(env.DB, userId);
      const subscribed = isActiveStatus(subscription.status);

      if (!subscribed) {
        const allowed = await consumeFreeUsage(env.DB, userId);
        if (!allowed) {
          return json(403, {
            error: `You've used your free bill summary for this year. Upgrade to Premium for unlimited summaries plus insurance matching, dispute letters, and spending tracking.`,
            needsSubscription: true
          });
        }
      }

      try {
        const body = await request.json();
        const result = await explainBill(env, { ...body, subscribed, userId });
        if (result.error && !subscribed) await refundFreeUsage(env.DB, userId);
        if (!result.error && subscribed) {
          const match = result.text && result.text.match(/```json\s*([\s\S]*?)```\s*$/i);
          if (match) {
            try {
              const parsed = JSON.parse(match[1].trim());
              if (CATEGORIES.includes(parsed.category) && typeof parsed.amountOwed === "number") {
                const cleanText = result.text.slice(0, match.index).trim();
                const billSnippet = ((body.text || "").slice(0, 200)).trim();
                const disputedAmount = typeof parsed.disputedAmount === "number" ? parsed.disputedAmount : 0;
                const provider = typeof parsed.provider === "string" ? parsed.provider.trim().slice(0, 200) : null;
                await addHistoryEntry(env.DB, userId, parsed.category, parsed.amountOwed, cleanText, billSnippet, disputedAmount, provider);
              }
            } catch { /* ignore bad JSON from model */ }
          }
        }
        return json(200, result);
      } catch (err) {
        if (!subscribed) await refundFreeUsage(env.DB, userId);
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const body = await request.json();
        const user = await createUser(env.DB, body);
        const token = await createToken(env.SESSION_SECRET, user.id);
        return json(200, { token, username: user.username });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const user = await verifyUser(env.DB, body);
        const token = await createToken(env.SESSION_SECRET, user.id);
        return json(200, { token, username: user.username });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      const user = await getUserById(env.DB, userId);
      if (!user) return json(401, { error: "Not logged in" });
      return json(200, { username: user.username, email: user.email });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      return json(200, { history: await getHistory(env.DB, auth.userId) });
    }

    if (url.pathname === "/api/history" && request.method === "POST") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      try {
        const { category, amount, explanation, billSnippet, disputedAmount, provider } = await request.json();
        await addHistoryEntry(env.DB, auth.userId, category, amount, explanation || null, billSnippet || null, disputedAmount || 0, provider || null);
        return json(200, { history: await getHistory(env.DB, auth.userId) });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT u.username, COALESCE(SUM(h.disputed_amount), 0) AS total_disputed, COUNT(*) AS dispute_count
        FROM history h
        JOIN users u ON u.id = h.user_id
        WHERE h.disputed_amount > 0
        GROUP BY u.id, u.username
        ORDER BY total_disputed DESC
        LIMIT 10
      `).all();
      return json(200, { leaderboard: results });
    }

    if (url.pathname === "/api/history/reset" && request.method === "POST") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      await resetHistory(env.DB, auth.userId);
      return json(200, { history: [] });
    }

    if (url.pathname === "/api/insurance" && request.method === "GET") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      return json(200, { text: await getInsurancePlan(env.DB, auth.userId) });
    }

    if (url.pathname === "/api/insurance" && request.method === "POST") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      try {
        const { text } = await request.json();
        await setInsurancePlan(env.DB, auth.userId, text || "");
        return json(200, { text: text || "" });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/avatar" && request.method === "GET") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      return json(200, { dataUrl: await getAvatar(env.DB, userId) });
    }

    if (url.pathname === "/api/avatar" && request.method === "POST") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      try {
        const { dataUrl } = await request.json();
        await setAvatar(env.DB, userId, dataUrl || "");
        return json(200, { dataUrl: dataUrl || "" });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/insurance/extract" && request.method === "POST") {
      const auth = await requireSubscription(env, request);
      if (auth.error) return auth.error;
      try {
        const body = await request.json();
        const result = await extractInsurancePlan(env, body);
        return json(200, result);
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname === "/api/subscription" && request.method === "GET") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      const sub = await getSubscription(env.DB, userId);
      const usageCount = await getUsageCount(env.DB, userId);
      return json(200, {
        status: sub.status,
        periodEnd: sub.periodEnd,
        usage: { count: usageCount, limit: FREE_YEARLY_LIMIT }
      });
    }

    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      try {
        const user = await getUserById(env.DB, userId);
        const stripe = getStripe(env);
        const origin = request.headers.get("origin") || url.origin;
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                recurring: { interval: "month" },
                product_data: { name: "Bill Explainer Premium" },
                unit_amount: PREMIUM_PRICE_CENTS
              },
              quantity: 1
            }
          ],
          client_reference_id: userId,
          metadata: { userId },
          subscription_data: { metadata: { userId } },
          customer_email: user?.email,
          success_url: `${origin}/?checkout=success`,
          cancel_url: `${origin}/?checkout=cancel`
        });
        return json(200, { url: session.url });
      } catch (err) {
        return json(400, { error: err.message || "Couldn't start checkout." });
      }
    }

    if (url.pathname === "/api/billing-portal" && request.method === "POST") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      try {
        const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(userId).first();
        if (!row || !row.stripe_customer_id) return json(400, { error: "No subscription on file yet." });

        const stripe = getStripe(env);
        const origin = request.headers.get("origin") || url.origin;
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: row.stripe_customer_id,
          return_url: `${origin}/`
        });
        return json(200, { url: portalSession.url });
      } catch (err) {
        return json(400, { error: err.message || "Couldn't open billing portal." });
      }
    }

    if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
      const signature = request.headers.get("stripe-signature");
      if (!signature) return new Response("Missing signature", { status: 400 });

      const body = await request.text();
      let event;
      try {
        const stripe = getStripe(env);
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature,
          env.STRIPE_WEBHOOK_SECRET,
          undefined,
          webCrypto
        );
      } catch (err) {
        return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
      }

      try {
        const already = await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(event.id).first();
        if (!already) {
          if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            const eventUserId = session.client_reference_id || session.metadata?.userId;
            if (eventUserId && session.mode === "subscription" && session.customer && session.subscription) {
              await env.DB
                .prepare(
                  "UPDATE users SET subscription_status = 'active', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?"
                )
                .bind(session.customer, session.subscription, eventUserId)
                .run();
            }
          } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
            const sub = event.data.object;
            const eventUserId = sub.metadata?.userId;
            if (eventUserId) {
              const periodEndIso = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
              await env.DB
                .prepare(
                  "UPDATE users SET subscription_status = ?, subscription_period_end = ?, stripe_subscription_id = ? WHERE id = ?"
                )
                .bind(sub.status, periodEndIso, sub.id, eventUserId)
                .run();
            }
          } else if (event.type === "customer.subscription.deleted") {
            const sub = event.data.object;
            const eventUserId = sub.metadata?.userId;
            if (eventUserId) {
              await env.DB
                .prepare("UPDATE users SET subscription_status = 'canceled' WHERE id = ?")
                .bind(eventUserId)
                .run();
            }
          }
          await env.DB
            .prepare("INSERT INTO stripe_events (id, created_at) VALUES (?, ?)")
            .bind(event.id, new Date().toISOString())
            .run();
        }
      } catch (err) {
        return new Response(`Webhook handling error: ${err.message}`, { status: 500 });
      }

      return new Response("", { status: 200 });
    }

    if (url.pathname === "/api/reminders" && request.method === "GET") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      return json(200, { reminders: await getReminders(env.DB, userId) });
    }

    if (url.pathname === "/api/reminders" && request.method === "POST") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      try {
        const { email, billLabel, amountOwed, dueDate, reminderDate } = await request.json();
        if (!reminderDate) return json(400, { error: "reminderDate is required" });
        const user = await getUserById(env.DB, userId);
        const toEmail = email || user?.email;
        if (!toEmail) return json(400, { error: "No email address on file" });
        const reminder = await createReminder(env.DB, { userId, email: toEmail, billLabel, amountOwed, dueDate, reminderDate });
        return json(200, { reminder });
      } catch (err) {
        return json(400, { error: err.message || "Bad request" });
      }
    }

    if (url.pathname.startsWith("/api/reminders/") && request.method === "DELETE") {
      const userId = await getAuthUserId(request, env.SESSION_SECRET);
      if (!userId) return json(401, { error: "Not logged in" });
      const id = url.pathname.slice("/api/reminders/".length);
      await deleteReminder(env.DB, id, userId);
      return json(200, { ok: true });
    }

    return json(404, { error: "Not found" });
  }
};
