const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { ANTHROPIC_API_KEY } = require("./config");

app.setName("Bill Explainer");

const MODEL = "claude-opus-4-8";
const SYSTEM_PROMPT = `You are a billing explainer assistant. The user will upload a photo or text of a bill — medical, insurance, utility, or other. They may also provide a summary of their insurance plan's coverage details.

Your job is to:
1. Identify what type of bill it is
2. Break down each charge in plain, simple English
3. If — and only if — the user provided details about their insurance plan, assess whether the charges are likely covered, partially covered, or not covered by that plan. Reference specific plan terms (deductible, copay, coinsurance, network status, exclusions) where relevant, and be honest about uncertainty rather than guessing confidently. If no insurance plan details were provided, skip this entirely.
4. Flag anything that looks unusual, duplicated, or genuinely worth questioning
5. Give a one-line summary of what they actually owe and why
6. If — and only if — something is genuinely inconsistent (duplicate charges, math errors, charges for services not received, mismatched dates/codes, amounts that contradict insurance EOB language, etc.) and worth disputing, draft a short, polite, factual message the person can send to the biller disputing it. Reference the specific line items and amounts. Do not invent a dispute if nothing is actually wrong — vague or minor items that are simply "worth asking about" do not warrant a dispute letter, only the "Worth double-checking" section.

Be clear and friendly. Avoid jargon. If something is unclear in the bill, say so honestly rather than guessing.

Format your response in this structure using markdown headers (##):
## What kind of bill this is
## Charge breakdown
## Insurance coverage likelihood
## Worth double-checking
## Bottom line
## Dispute letter

Only include the "Insurance coverage likelihood" section if the user provided insurance plan details; otherwise omit it entirely — do not include it with placeholder or "no insurance info provided" text. Only include the "Dispute letter" section if step 6 applies. If there's nothing worth disputing, omit that section entirely — do not include it with placeholder or "nothing to dispute" text.

After all of the above, end your response with exactly one fenced code block tagged json containing the bill's category, the total amount owed, the disputed amount, and the payment due date. "category" must be exactly one of: "Medical", "Insurance", "Utility", "Other". "amountOwed" must be a plain number (no currency symbol, no commas) — your best reading of the total the person owes; use your best estimate if the bill doesn't state it outright. "disputedAmount" must be a plain number representing the specific dollar amount being disputed in the dispute letter, or 0 if no dispute letter was written. "dueDate" must be the payment due date as an ISO date string ("YYYY-MM-DD") if clearly stated on the bill, or null if not found. Example:
\`\`\`json
{"category": "Medical", "amountOwed": 128.50, "disputedAmount": 45.00, "dueDate": "2026-08-15"}
\`\`\``;

const INSURANCE_EXTRACT_PROMPT = `You are an assistant that reads insurance plan documents (text, photos, or PDFs of them) and extracts the key coverage facts a person needs to know when checking whether a medical bill is covered. Summarize in clear plain text: deductible (individual/family), copay and coinsurance amounts, in-network vs out-of-network differences, annual out-of-pocket maximum, and anything explicitly excluded or requiring prior authorization. Be concise and factual — do not add commentary or disclaimers. If the provided content doesn't look like an insurance plan document, say so plainly instead of guessing.`;

function createWindow() {
  const win = new BrowserWindow({
    width: 820,
    height: 900,
    title: "Bill Explainer",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });
  win.loadFile("index.html");
}

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

ipcMain.handle("explain-bill", async (_event, { text, imageBase64, imageMediaType, insurancePlanText }) => {
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
});

ipcMain.handle("extract-insurance-plan", async (_event, { text, imageBase64, imageMediaType }) => {
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
});

app.whenReady().then(() => {
  if (app.dock) {
    app.dock.setIcon(path.join(__dirname, "icon.iconset", "icon_512x512.png"));
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
