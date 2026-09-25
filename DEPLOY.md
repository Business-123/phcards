# Deploying to Railway via GitHub

This repo runs as a single Railway service: **Phantom Cards** (this root
directory), the marketplace app. It talks directly to the **Payment Hub** (a
separate project — see that repo's own README), which is the only thing that
holds a Paystack secret key. Phantom Cards authenticates to the hub with its
own `HUB_API_KEY` / `HUB_API_SECRET` merchant credentials.

## 1. Push this repo to GitHub

```bash
git init
git add .
git commit -m "Prepare for Railway deployment"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env` and `data/` — double-check `git status`
before your first commit so no local secrets or JSON data files get committed.

## 2. Create the Railway project

1. In Railway, **New Project → Deploy from GitHub repo**, pick this repo.
2. On that service: **Settings → Deploy → Start Command** → `npm start`
   (this repo's root `railway.json` already sets this, so it's optional).

Your service's public URL is your `APP_BASE_URL`.

## 3. Environment variables

**Settings → Variables:**

```env
PORT=3000                       # Railway sets PORT automatically; leave unset and it just works
APP_BASE_URL=https://<your-app>.up.railway.app
PAYSTACK_CURRENCY=GHS
HUB_BASE_URL=https://<your-payment-hub>.up.railway.app   # the /api/v1 suffix is added automatically (also accepted if you include it)
HUB_API_KEY=<issued by the Payment Hub for this merchant>
HUB_API_SECRET=<issued by the Payment Hub for this merchant>
PAYMENT_SESSION_MINUTES=15
PHANTOM_DATA_FILE=/data/phantom-cards.json     # see "Persistent storage" below
NODE_ENV=production
ADMIN_EMAIL=<your admin login email>
ADMIN_PASSWORD_HASH=<scrypt hash; never commit>  # required to use /admin (see README)
```

KYC documents are stored next to `PHANTOM_DATA_FILE` by default, so they are
kept on the same `/data` volume.

## 4. Register with the Payment Hub

On the Payment Hub (its admin dashboard, or its `npm run seed:merchant`
script), create a merchant for this site and set its `webhookUrl` to:

```text
https://<your-app>.up.railway.app/api/webhooks/hub
```

Copy the `apiKey`/`apiSecret` it issues into this service's `HUB_API_KEY` /
`HUB_API_SECRET` variables above.

## 5. Persistent storage (important)

The app stores its data as a JSON file on local disk
(`data/phantom-cards.json`). Railway's container filesystem is **not**
durable across redeploys — a new deploy starts from a clean image, so
without a volume you'd lose all users, cards, payments, and orders every time
you push a change.

1. Service → **Settings → Volumes → New Volume**, mount it at `/data`.
2. Point `PHANTOM_DATA_FILE` at a path under `/data` (already shown above).
3. Redeploy so the app picks up the new path — the `load()`/`save()`
   functions in `server.js` create the file/directory automatically if it
   doesn't exist yet.

## 6. Verify

- `GET https://<your-app>.up.railway.app/` should load the marketplace.
- `GET https://<your-app>.up.railway.app/api/health` should return
  `{"ok":true,"hubConfigured":true}`. If `hubConfigured` is `false`, double
  check `HUB_BASE_URL` / `HUB_API_KEY` / `HUB_API_SECRET`.
- Buy the cheapest card end to end to confirm the app → Hub → Paystack →
  webhook back to the app all connect correctly (the card should appear
  under Redeem after payment).

## Ongoing deploys

Once connected, every `git push` to the branch Railway is watching
redeploys the service automatically.
