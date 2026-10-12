# Ikeda

Wholesale air freshener company site — one unified project, frontend + backend together, every piece of content editable by an admin.

## Structure
- `index.html`, `admin.html` — the homepage and admin panel (static, no build step)
- `api/index.js` — **the backend you're actually using on Vercel.** One Express app running as a Vercel serverless function, backed by **Postgres (Supabase)** via the standard `pg` driver. Handles every `/api/*` route.
- `server/` — the same backend logic, packaged instead as a traditional always-running Node server with a local SQLite file. Only relevant if you ever move off Vercel to a host like Railway/Render; **not used when deployed on Vercel.**
- `vercel.json` — routes `/api/*` to `api/index.js`; everything else (the HTML files) is served by Vercel as static files directly.

Vercel doesn't run a persistent server and its filesystem isn't writable/persistent, so `api/index.js` can't use SQLite the way `server/` does — it talks to a real hosted Postgres database instead (Supabase works with any standard Postgres client, which is why this uses plain `pg` rather than a Vercel-specific client). Same design either way: one `content` table every editable field lives in, one `submissions` table, one `admins` table.

## Deploying on Vercel, with Supabase as the database

1. **Create a Supabase project** at supabase.com (free tier is fine).
2. In Supabase: **Project Settings → Database → Connection string**. Use the **Connection Pooling** string (port `6543`, has `pgbouncer=true` in it), not the direct connection — a serverless function opens a fresh connection on every invocation, which exhausts Postgres's direct connection limit fast. Copy that full string, replacing `[YOUR-PASSWORD]` with your actual database password.
3. In your **Vercel project → Settings → Environment Variables**, add:
   - `DATABASE_URL` — the connection string from step 2 (the code also accepts `POSTGRES_URL` if you'd rather name it that)
   - `ADMIN_USERNAME` — e.g. `admin`
   - `ADMIN_PASSWORD` — a real password (only read once, to create the admin account the very first time the `admins` table is empty)
   - `JWT_SECRET` — any long random string (signs admin login sessions)
   - `ALLOWED_ORIGIN` — `*` is fine to start; lock to your real domain later
4. **Redeploy** (or just push — Vercel redeploys on push automatically). The first request after deploy creates the three tables and seeds the admin account automatically; nothing to run manually in Supabase's SQL editor.
5. Visit `https://<your-domain>/admin.html` and log in with the `ADMIN_USERNAME`/`ADMIN_PASSWORD` from step 3.

That's it — homepage, forms, and admin all work from the same Vercel domain after this.

## Admin panel — editing the homepage
Every heading, body of copy, image URL, the two background video URLs, and the seven brand colors are editable from `/admin.html`, saved straight to the database, and reflected on the homepage immediately — no redeploy needed, since `index.html` fetches `/api/content` on every load.

**Change the password after first login** — there's no "forgot password" flow yet, and editing `ADMIN_PASSWORD` in Vercel's env vars afterward does nothing (it's only read once, when the `admins` table is empty). Use the panel's password-change instead.

Note: the brand colors are one fixed palette — the homepage's light/dark toggle still works, but a custom color applies in both modes rather than having separate light/dark variants.

## Reading form submissions
```
curl -H "x-admin-token: <set an ADMIN_TOKEN env var for this>" https://<your-domain>/api/submissions
```

## Running locally against Supabase
```
npm install
echo "DATABASE_URL=<your Supabase pooling connection string>" > .env
npx vercel dev
```

## Alternative: traditional hosting instead of Vercel (`server/`)
If you ever move off Vercel to something that runs a persistent Node process (Railway, Render, Fly.io), use `server/` instead of `api/`/Postgres — it's the same backend with local SQLite, no separate database to provision:
```
cd server
cp .env.example .env
npm install
npm start
```
Set `DB_PATH` to a persistent volume's path in production, or the database resets on every redeploy.
