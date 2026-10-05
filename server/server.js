require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---- one database, one place every submission lands, regardless of
// which form on the site it came from (contact, wholesale quote, or
// anything added later) ----
const db = new Database(path.join(__dirname, "data.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,             -- 'contact' | 'wholesale' | 'newsletter'
    name TEXT,                      -- newsletter signups are email-only
    email TEXT NOT NULL,
    company TEXT,
    phone TEXT,
    message TEXT,
    volume TEXT,                    -- wholesale-only: estimated monthly volume
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Serve the homepage itself — one deployable unit, not a separate
// frontend host talking to a separate backend host.
app.use(express.static(path.join(__dirname, "..")));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TYPES = new Set(["contact", "wholesale", "newsletter"]);

// Very small in-memory rate limit, per IP — enough to stop a script
// hammering the endpoint without needing a separate service for it.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry = hits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > 20;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---- the one, unified intake point for every form on the site ----
app.post("/api/submissions", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) {
    return res.status(429).json({ success: false, error: "Too many submissions. Please try again later." });
  }

  const { type, name, email, company, phone, message, volume } = req.body || {};

  if (!VALID_TYPES.has(type)) {
    return res.status(400).json({ success: false, error: "Invalid submission type" });
  }
  if (!email) {
    return res.status(400).json({ success: false, error: "Email is required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: "Invalid email address" });
  }
  // Newsletter signups are email-only by design — contact and wholesale
  // still need a name and message.
  if (type !== "newsletter" && (!name || !message)) {
    return res.status(400).json({ success: false, error: "Name and message are required" });
  }
  if (type === "wholesale" && !company) {
    return res.status(400).json({ success: false, error: "Company name is required for a wholesale quote" });
  }

  const stmt = db.prepare(`
    INSERT INTO submissions (type, name, email, company, phone, message, volume)
    VALUES (@type, @name, @email, @company, @phone, @message, @volume)
  `);
  const info = stmt.run({
    type,
    name: name ? String(name).slice(0, 200) : null,
    email: String(email).slice(0, 320),
    company: company ? String(company).slice(0, 200) : null,
    phone: phone ? String(phone).slice(0, 50) : null,
    message: message ? String(message).slice(0, 5000) : null,
    volume: volume ? String(volume).slice(0, 100) : null,
  });

  res.json({ success: true, id: info.lastInsertRowid });
});

// Minimal read-back so submissions are actually reachable without opening
// the database file by hand — swap for real auth before going live.
app.get("/api/submissions", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const rows = db.prepare("SELECT * FROM submissions ORDER BY created_at DESC").all();
  res.json({ success: true, data: rows });
});

app.listen(PORT, () => console.log(`Ikeda backend running on http://localhost:${PORT}`));
