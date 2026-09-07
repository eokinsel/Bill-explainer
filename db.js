const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// DATA_DIR lets a deployment point this at a mounted persistent volume
// (container filesystems are ephemeral — without it, accounts and history
// would be wiped on every redeploy/restart).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "data.json");

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], history: [], secret: crypto.randomBytes(32).toString("hex") };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const db = load();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createUser({ username, email, password }) {
  username = username.trim();
  email = email.trim().toLowerCase();

  if (!username || !email || !password) {
    throw new Error("Username, email, and password are all required.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error("That username is already taken.");
  }
  if (db.users.some((u) => u.email === email)) {
    throw new Error("That email is already registered.");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: crypto.randomUUID(),
    username,
    email,
    salt,
    passwordHash: hashPassword(password, salt)
  };
  db.users.push(user);
  save();
  return user;
}

function verifyUser({ identifier, password }) {
  identifier = identifier.trim().toLowerCase();
  const user = db.users.find(
    (u) => u.username.toLowerCase() === identifier || u.email === identifier
  );
  if (!user) throw new Error("No account found with that username or email.");

  const candidate = Buffer.from(hashPassword(password, user.salt));
  const actual = Buffer.from(user.passwordHash);
  if (candidate.length !== actual.length || !crypto.timingSafeEqual(candidate, actual)) {
    throw new Error("Incorrect password.");
  }
  return user;
}

function createToken(userId) {
  const payload = JSON.stringify({ userId, exp: Date.now() + 1000 * 60 * 60 * 24 * 90 });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", db.secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto.createHmac("sha256", db.secret).update(payloadB64).digest("base64url");
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

function getUserById(id) {
  return db.users.find((u) => u.id === id);
}

function getHistory(userId) {
  return db.history
    .filter((h) => h.userId === userId)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(({ id, category, amount, date, explanation, billSnippet, disputedAmount, provider }) => ({ id, category, amount, date, explanation: explanation || null, billSnippet: billSnippet || null, disputedAmount: disputedAmount || 0, provider: provider || null }));
}

function addHistoryEntry(userId, category, amount, explanation, billSnippet, disputedAmount, provider) {
  const entry = { id: crypto.randomUUID(), userId, category, amount, date: new Date().toISOString(), explanation: explanation || null, billSnippet: billSnippet || null, disputedAmount: disputedAmount || 0, provider: provider || null };
  db.history.push(entry);
  save();
  return entry;
}

function getLeaderboard() {
  const totals = {};
  const names = {};
  for (const h of db.history) {
    if ((h.disputedAmount || 0) > 0) {
      totals[h.userId] = (totals[h.userId] || 0) + h.disputedAmount;
    }
  }
  for (const u of db.users) {
    if (totals[u.id]) names[u.id] = u.username;
  }
  return Object.entries(totals)
    .map(([id, total_disputed]) => ({ username: names[id], total_disputed }))
    .sort((a, b) => b.total_disputed - a.total_disputed)
    .slice(0, 10);
}

function resetHistory(userId) {
  db.history = db.history.filter((h) => h.userId !== userId);
  save();
}

function getInsurancePlan(userId) {
  const user = getUserById(userId);
  return user ? user.insurancePlan || "" : "";
}

function setInsurancePlan(userId, text) {
  const user = getUserById(userId);
  if (!user) return;
  user.insurancePlan = text || "";
  save();
}

function getAvatar(userId) {
  const user = getUserById(userId);
  return user ? user.avatar || "" : "";
}

function setAvatar(userId, dataUrl) {
  const user = getUserById(userId);
  if (!user) return;
  user.avatar = dataUrl || "";
  save();
}

module.exports = {
  createUser,
  verifyUser,
  createToken,
  verifyToken,
  getUserById,
  getHistory,
  addHistoryEntry,
  resetHistory,
  getInsurancePlan,
  setInsurancePlan,
  getAvatar,
  setAvatar,
  getLeaderboard
};
