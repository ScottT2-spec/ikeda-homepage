const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

// Vercel doesn't run a persistent process (no app.listen here — Vercel
// invokes this module as a function per request) and its filesystem is
// not writable/persistent, so this talks to a hosted Postgres database
// (Supabase, or any standard Postgres provider) via `pg` instead of the
// SQLite file the server/ version uses for traditional hosting. Same
// unified design either way: one database, one content table, one
// submissions table, one admin table.
//
// Reads POSTGRES_URL first, DATABASE_URL as a fallback (Supabase's own
// docs call it DATABASE_URL — supporting both avoids a naming mismatch).
// Supabase: use the "Connection Pooling" string (port 6543), not the
// direct connection — serverless functions open a fresh connection per
// invocation, which exhausts a direct Postgres connection limit fast.
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let pool = null;
function getPool() {
  if (!pool) {
    if (!connectionString) {
      throw new Error("No database configured — set POSTGRES_URL or DATABASE_URL in your Vercel env vars.");
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}
// Tiny helper so the rest of the file reads close to the previous
// sql`...` tagged-template version — db.query(text, params).
function db() {
  return { query: (text, params) => getPool().query(text, params) };
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TYPES = new Set(["contact", "wholesale", "newsletter"]);

const CONTENT_DEFAULTS = {
  "brand.logo_text": "IKEDA",
  "brand.color.paper": "#F5F2F0",
  "brand.color.paper2": "#EDEAEA",
  "brand.color.ink": "#101010",
  "brand.color.inkSoft": "#706F6E",
  "brand.color.clay": "#A68464",
  "brand.color.moss": "#9073BB",
  "brand.color.line": "#DAD7D5",
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

// Runs once per cold start (each warm function instance skips it on
// subsequent invocations) rather than on every request. Every statement
// here is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING), so even
// if several instances cold-start concurrently, nothing is overwritten.
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const { query } = db();
      await query(`
        CREATE TABLE IF NOT EXISTS submissions (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT,
          email TEXT NOT NULL,
          company TEXT,
          phone TEXT,
          message TEXT,
          volume TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS admins (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS page_views (
          id SERIAL PRIMARY KEY,
          path TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const { rows } = await query("SELECT COUNT(*)::int AS c FROM admins");
      if (rows[0].c === 0) {
        const username = process.env.ADMIN_USERNAME || "admin";
        const password = process.env.ADMIN_PASSWORD || "changeme";
        const hash = bcrypt.hashSync(password, 10);
        await query("INSERT INTO admins (username, password_hash) VALUES ($1, $2)", [username, hash]);
        console.log(`Seeded admin account "${username}" — set ADMIN_USERNAME/ADMIN_PASSWORD in Vercel env vars before going live.`);
      }

      for (const [key, value] of Object.entries(CONTENT_DEFAULTS)) {
        await query("INSERT INTO content (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, value]);
      }
    })();
  }
  return initPromise;
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(async (_req, _res, next) => { await ensureInit(); next(); });

// In-memory per-instance rate limit. Weaker than the single-server
// version -- serverless spins up multiple instances that don't share
// this Map -- but still blocks a script hammering one warm instance.
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

app.post("/api/submissions", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) {
    return res.status(429).json({ success: false, error: "Too many submissions. Please try again later." });
  }

  const { type, name, email, company, phone, message, volume } = req.body || {};

  if (!VALID_TYPES.has(type)) return res.status(400).json({ success: false, error: "Invalid submission type" });
  if (!email) return res.status(400).json({ success: false, error: "Email is required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: "Invalid email address" });
  if (type !== "newsletter" && (!name || !message)) {
    return res.status(400).json({ success: false, error: "Name and message are required" });
  }
  if (type === "wholesale" && !company) {
    return res.status(400).json({ success: false, error: "Company name is required for a wholesale quote" });
  }

  const { rows } = await db().query(
    `INSERT INTO submissions (type, name, email, company, phone, message, volume)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      type,
      name ? String(name).slice(0, 200) : null,
      String(email).slice(0, 320),
      company ? String(company).slice(0, 200) : null,
      phone ? String(phone).slice(0, 50) : null,
      message ? String(message).slice(0, 5000) : null,
      volume ? String(volume).slice(0, 100) : null,
    ]
  );
  res.json({ success: true, id: rows[0].id });
});

app.get("/api/admin/submissions", requireAdmin, async (req, res) => {
  const { rows } = await db().query("SELECT * FROM submissions ORDER BY created_at DESC");
  res.json({ success: true, data: rows });
});

app.delete("/api/admin/submissions/:id", requireAdmin, async (req, res) => {
  await db().query("DELETE FROM submissions WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

// Public, fire-and-forget -- called once per homepage load. Never blocks
// or errors the page if it fails; analytics is a nice-to-have, not a
// dependency of the site working.
app.post("/api/track", async (req, res) => {
  try {
    const path = req.body?.path ? String(req.body.path).slice(0, 200) : "/";
    await db().query("INSERT INTO page_views (path) VALUES ($1)", [path]);
  } catch { /* swallow -- tracking failures should never surface to visitors */ }
  res.json({ success: true });
});

app.get("/api/admin/analytics", requireAdmin, async (req, res) => {
  const { query } = db();
  const [totalViews, viewsByDay, totalSubs, subsByType, subsByDay] = await Promise.all([
    query("SELECT COUNT(*)::int AS c FROM page_views"),
    query(`SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
           FROM page_views WHERE created_at > NOW() - INTERVAL '14 days'
           GROUP BY day ORDER BY day`),
    query("SELECT COUNT(*)::int AS c FROM submissions"),
    query("SELECT type, COUNT(*)::int AS c FROM submissions GROUP BY type"),
    query(`SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS c
           FROM submissions WHERE created_at > NOW() - INTERVAL '14 days'
           GROUP BY day ORDER BY day`),
  ]);
  res.json({
    success: true,
    data: {
      totalViews: totalViews.rows[0].c,
      viewsByDay: viewsByDay.rows,
      totalSubmissions: totalSubs.rows[0].c,
      submissionsByType: subsByType.rows,
      submissionsByDay: subsByDay.rows,
    },
  });
});

app.get("/api/content", async (_req, res) => {
  const { rows } = await db().query("SELECT key, value FROM content");
  res.json({ success: true, data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

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

app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = username ? await db().query("SELECT * FROM admins WHERE username = $1", [username]) : { rows: [] };
  const row = rows[0];
  if (!row || !bcrypt.compareSync(password || "", row.password_hash)) {
    return res.status(401).json({ success: false, error: "Invalid username or password" });
  }
  const token = jwt.sign({ sub: row.id, username: row.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ success: true, token });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, data: { username: req.admin.username } });
});

app.post("/api/admin/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const { rows } = await db().query("SELECT * FROM admins WHERE id = $1", [req.admin.sub]);
  const row = rows[0];
  if (!row || !bcrypt.compareSync(currentPassword || "", row.password_hash)) {
    return res.status(401).json({ success: false, error: "Current password is incorrect" });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: "New password must be at least 8 characters" });
  }
  await db().query("UPDATE admins SET password_hash = $1 WHERE id = $2", [bcrypt.hashSync(newPassword, 10), row.id]);
  res.json({ success: true });
});

app.put("/api/admin/content", requireAdmin, async (req, res) => {
  const updates = req.body || {};
  const keys = Object.keys(updates);
  if (!keys.length) return res.status(400).json({ success: false, error: "No fields to update" });
  for (const key of keys) {
    if (!(key in CONTENT_DEFAULTS)) return res.status(400).json({ success: false, error: `Unknown field: ${key}` });
  }
  for (const [key, value] of Object.entries(updates)) {
    await db().query(
      `INSERT INTO content (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value)]
    );
  }
  res.json({ success: true });
});

module.exports = app;
