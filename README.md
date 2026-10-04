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
