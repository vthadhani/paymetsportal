# PayPortal BZ — Dual-Gateway Payment Portal

Payment link and QR code generator supporting **Stripe** (international credit cards)
and **Atlantic Bank Belize / PlaceToPay** (local BZD debit cards).

---

## Project structure

```
payportal/
├── public/
│   └── index.html        ← Full single-page application
├── Dockerfile            ← nginx:alpine image, no build step
├── docker-compose.yml    ← For local testing & Coolify reference
├── nginx.conf            ← Nginx server block config
├── .env.example          ← Copy to .env and fill in your keys
└── .dockerignore
```

---

## Deploy on Coolify (recommended)

### Option A — Git repository (easiest)

1. Push this folder to a GitHub / GitLab repo.
2. In Coolify → **New Resource → Application → Public/Private Git repo**.
3. Set **Build pack → Dockerfile** (Coolify auto-detects it).
4. Add your environment variables under **Environment Variables**:

   | Key | Value |
   |-----|-------|
   | `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` |
   | `STRIPE_SECRET_KEY` | `sk_live_...` |
   | `PTP_LOGIN` | your PlaceToPay login |
   | `PTP_SECRET` | your PlaceToPay secret |
   | `PTP_ENDPOINT` | endpoint URL from Atlantic Bank |
   | `PTP_RETURN_URL` | `https://yourdomain.com/payment/return` |

5. Set your **domain** in Coolify → it handles SSL (Let's Encrypt) automatically.
6. Click **Deploy**. Done.

### Option B — Deploy from VPS directly

```bash
# 1. Upload / clone the files to your VPS
scp -r ./payportal user@your-vps-ip:/opt/payportal

# 2. SSH in
ssh user@your-vps-ip

# 3. Copy env file and fill in values
cd /opt/payportal
cp .env.example .env
nano .env

# 4. Build and run
docker compose up -d --build

# App is now running on port 8080
# Point your reverse proxy / Coolify domain to port 8080
```

---

## Test locally

```bash
docker compose up --build
# Open http://localhost:8080
```

---

## PlaceToPay / Atlantic Bank integration

The current version generates **demo-format** PlaceToPay URLs.
To generate **real** PlaceToPay sessions:

1. Contact Atlantic Bank Belize to get:
   - Merchant `login` and `secretKey`
   - Exact API endpoint URL for Belize
   - Sandbox credentials for testing

2. Add a small backend endpoint (Node.js / PHP) that:
   - Receives payment details from this frontend
   - Calls PlaceToPay API with HMAC-SHA256 auth
   - Returns the `processUrl` to the frontend

3. In the "Create link" form, paste the returned `processUrl` as the payment link.

See the **Integration guide** tab inside the app for the full API code.

---

## Ports

| Environment | Port |
|-------------|------|
| Docker (local) | `8080` |
| Coolify | Assigned automatically, SSL termination handled |

---

## Data storage

Payment links are stored in **browser localStorage** — no database required.
Use the **Export CSV** feature in Settings to back up your data.

If you need persistent server-side storage, the next step is adding a
lightweight backend with SQLite or PostgreSQL and a REST API.
