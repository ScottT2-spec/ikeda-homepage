# Ikeda

Wholesale air freshener company site — one unified project, frontend + backend together.

## Structure
- `index.html` — the homepage (static, no build step)
- `server/` — the backend: one Express service, one SQLite DB, one endpoint (`POST /api/submissions`) that every form on the site submits to (Contact and Wholesale Quote both use it, distinguished by a `type` field). Also serves `index.html` itself, so the whole thing runs as a single process.

## Run locally
```
cd server
cp .env.example .env
npm install
npm start
```
Then open http://localhost:4000 — the homepage and the API are served from the same origin.

## Reading submissions
```
curl -H "x-admin-token: <ADMIN_TOKEN from .env>" http://localhost:4000/api/submissions
```

## Admin panel — editing the homepage
Visit `http://localhost:4000/admin.html`. Default login is `admin` / `changeme`
(set via `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`, only read once to seed
the account on first boot — change the password from the panel after that,
not by editing `.env` again).

Every piece of copy, every image URL, every background video URL, and the
seven brand colors are editable there, saved to `content` in the same
SQLite database, and reflected on the live homepage immediately (no
rebuild/redeploy needed — `index.html` fetches `/api/content` on load).

Note: the brand colors apply as one fixed palette. The homepage's
light/dark toggle still works, but a custom color set via the admin panel
is used in both modes rather than having separate light/dark variants —
full per-mode color editing isn't built yet.
