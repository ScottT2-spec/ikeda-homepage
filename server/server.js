require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";

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
  );

  -- Every editable piece of the homepage -- copy, image/video URLs, and
  -- the brand color variables -- lives here as one flat key/value map.
  -- The homepage fetches this on load and the admin panel writes to it.
  -- One table, one edit surface, not a separate system per field type.
  CREATE TABLE IF NOT EXISTS content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );
`);

// Seed the admin account once, from env, on first boot only.
if (db.prepare("SELECT COUNT(*) AS c FROM admins").get().c === 0) {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "changeme";
  db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)")
    .run(username, bcrypt.hashSync(password, 10));
  console.log(`Seeded admin account "${username}" — set ADMIN_USERNAME/ADMIN_PASSWORD in .env before going live.`);
}

// Every piece of copy, image, video, and color currently hardcoded on the
// homepage, as the default an admin edit overrides. Seeded once; after
// that the DB is the source of truth.
const CONTENT_DEFAULTS = {
  "brand.logo_text": "IKEDA",
  "brand.color.paper": "#F2F4EF",
  "brand.color.paper2": "#EAEEE6",
  "brand.color.ink": "#1E2A22",
  "brand.color.inkSoft": "#49584D",
  "brand.color.clay": "#B5572F",
  "brand.color.moss": "#5C7A62",
  "brand.color.line": "#D9E0D4",
  "nav.cta_text": "Shop Online",
  "hero.heading": "Fragrance that holds up, at any volume.",
  "hero.subheading": "IKEDA manufactures and supplies air fresheners for home, auto, and commercial spaces — in the case quantities wholesalers and retailers actually need.",
  "hero.cta_text": "Request Wholesale Pricing →",
  "hero.video_url": "https://cdn.pixabay.com/video/2025/02/12/257927_large.mp4",
  "lines.heading": "Three ranges, one supply chain",
  "lines.subheading": "Every range ships the same way: consistent fragrance, reliable case counts, and lead times built for repeat wholesale orders.",
  "card1.title": "Home & Living",
  "card1.body": "Reed diffusers, candles, and room sprays — stocked in the pack sizes retail shelves actually move.",
  "card1.image_url": "https://cdn.pixabay.com/photo/2019/03/24/01/21/aroma-4076727_1280.jpg",
  "card2.title": "Auto & Mobile",
  "card2.body": "Vent clips and car sprays built for rental fleets, taxis, and forecourt retail alike.",
  "card2.image_url": "https://cdn.pixabay.com/photo/2022/01/11/16/01/car-freshener-6930966_1280.jpg",
  "card3.title": "Commercial & Wholesale",
  "card3.body": "Bulk fresheners and HVAC scenting, with custom fragrance and private label on request.",
  "card3.image_url": "https://cdn.pixabay.com/photo/2016/07/29/14/55/storage-warehouse-1553550_1280.jpg",
  "statement.quote": "\"A fragrance that's right once is a formula. A fragrance that's right on every pallet, every time, is a business.\"",
  "statement.attribution": "IKEDA, on manufacturing",
  "statement.video_url": "https://cdn.pixabay.com/video/2023/12/04/192012-891324245_large.mp4",
  "about.heading": "About Us",
  "about.body": "IKEDA is a wholesale air freshener manufacturer, supplying retailers, distributors, and fleets with consistent fragrance at case and pallet volume — plus custom and private-label runs for partners who need their own brand on the shelf.",
  "about.image_url": "https://cdn.pixabay.com/photo/2016/07/29/14/55/storage-warehouse-1553550_1280.jpg",
  "story.heading": "Our Story",
  "story.body": "IKEDA started supplying a handful of local retailers with one reliable scent. Demand for consistent, repeatable fragrance at scale built the rest — today the same formulas ship by the pallet, unchanged order to order.",
  "story.image_url": "https://cdn.pixabay.com/photo/2019/03/24/01/21/aroma-4076727_1280.jpg",
  "wholesale.heading": "Get a wholesale quote",
  "wholesale.subheading": "Tell us a bit about your business and we'll get back with pricing, lead times, and samples.",
  "contact.heading": "General question?",
  "contact.subheading": "For anything that isn't a wholesale order, send us a message directly.",
  "newsletter.heading": "Stay in the loop",
  "newsletter.subheading": "New ranges, restocks, and wholesale offers — straight to your inbox, nothing else.",
  "footer.legal": "IKEDA S.p.A. — Placeholder Registered Address, City, Country<br>Registration No. 00000000 — VAT 00000000000 — contact@ikeda.example",
  "footer.copyright": "©2026 IKEDA. All rights reserved.",
};
const insertDefault = db.prepare("INSERT OR IGNORE INTO content (key, value) VALUES (?, ?)");
const seedContent = db.transaction((defaults) => {
  for (const [key, value] of Object.entries(defaults)) insertDefault.run(key, value);
});
seedContent(CONTENT_DEFAULTS);

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

// ---- public: the homepage reads every editable field from here ----
app.get("/api/content", (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM content").all();
  const content = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({ success: true, data: content });
});

// ---- admin auth ----
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "Not logged in" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: "Session expired — please log in again" });
  }
}

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const row = username && db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  if (!row || !bcrypt.compareSync(password || "", row.password_hash)) {
    return res.status(401).json({ success: false, error: "Invalid username or password" });
  }
  const token = jwt.sign({ sub: row.id, username: row.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, data: { username: req.admin.username } });
});

app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const row = db.prepare("SELECT * FROM admins WHERE id = ?").get(req.admin.sub);
  if (!row || !bcrypt.compareSync(currentPassword || "", row.password_hash)) {
    return res.status(401).json({ success: false, error: "Current password is incorrect" });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: "New password must be at least 8 characters" });
  }
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), row.id);
  res.json({ success: true });
});

// ---- admin: edit any content field(s) in one call ----
app.put("/api/admin/content", requireAdmin, (req, res) => {
  const updates = req.body || {};
  const keys = Object.keys(updates);
  if (!keys.length) return res.status(400).json({ success: false, error: "No fields to update" });
  for (const key of keys) {
    if (!(key in CONTENT_DEFAULTS)) {
      return res.status(400).json({ success: false, error: `Unknown field: ${key}` });
    }
  }
  const upsert = db.prepare(`
    INSERT INTO content (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = @value
  `);
  const applyAll = db.transaction((entries) => {
    for (const [key, value] of entries) upsert.run({ key, value: String(value) });
  });
  applyAll(Object.entries(updates));
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`Ikeda backend running on http://localhost:${PORT}`));
