# PHANTOM CARDS

Phantom Cards is a single service, running on port 3000, that owns accounts,
Redeemed Balance, cards, redemptions, and withdrawals. It talks directly to
the **Payment Hub** — a separate service (see the hub's own repo/README) that is the
only thing that holds a Paystack secret key. Phantom Cards authenticates to the hub
with its own `HUB_API_KEY` / `HUB_API_SECRET` merchant credentials.

## Payments and withdrawal verification

`Browser (tap BUY) → POST /api/purchases → pending CARD_PURCHASE → Payment Hub → Paystack → Hub webhook → card + redeem code issued`

There is no wallet top-up: a card is paid for directly when the customer taps BUY. The server opens a hub checkout for exactly the card price and holds one unit of stock for `PAYMENT_SESSION_MINUTES` (default 15). The purchase and redeem code are created only after the hub confirms the charge (webhook, or the browser's return, which is re-verified with the hub). Failed or abandoned payments release the held stock. Redemption credits only Redeemed Balance; withdrawals debit only Redeemed Balance. Balances from older wallet deposits are kept in the data but can no longer be spent.

Withdrawals unlock after **three lifetime card redemptions**. The requested amount is held from Redeemed Balance and a 10% operational charge is shown before confirmation. Unverified users can submit KYC for review, or choose the per-withdrawal GHS 70 KYC bypass. The bypass is a hub-mediated Paystack checkout: it only auto-approves the withdrawal after the hub confirms payment (verification or webhook). It never marks the account as KYC verified.

Copy `.env.example` to `.env` and configure `HUB_BASE_URL`, `HUB_API_KEY`, and
`HUB_API_SECRET` with the credentials the Payment Hub issues for this merchant.

Run:

```bash
npm run dev
```

For phone/browser testing, expose the local service through an HTTPS tunnel:

```bash
cloudflared tunnel --url http://localhost:3000  # e.g. https://cards.example.com
```

Then update and restart:

```env
APP_BASE_URL=https://cards.example.com
```

On the Payment Hub, set this merchant's webhook URL to `https://cards.example.com/api/webhooks/hub`.

## Admin console

Phantom Cards includes a separate desktop-first operations console at `/admin`.
It provides server-side views for overview metrics, users, cards, purchases,
historical deposits, payment references, redemptions, withdrawals, KYC, transactions,
and audit logs. Existing withdrawal and KYC mutations are protected by an
admin session and require a note/reason; historical financial records and
balances are not directly editable.

Configure admin login credentials in `.env` before using the console:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD_HASH=<preferred-scrypt-hash>
```

For local-only development, `ADMIN_PASSWORD` may be used instead of
`ADMIN_PASSWORD_HASH`. Do not commit either value. The old
`ADMIN_APPROVAL_TOKEN` remains accepted for backwards-compatible server-to-
server/manual calls, but the dashboard uses the session login.

Open `http://127.0.0.1:3000/admin` after starting the app.

## APIs

- App → Payment Hub: `POST /api/v1/transaction/initialize` and `GET /api/v1/transaction/verify/:reference`, `x-api-key` + `x-signature` (HMAC-SHA512) authentication.
- Payment Hub → App: `POST /api/webhooks/hub`, raw-body HMAC-SHA512 validation against `HUB_API_SECRET`.
- User status: `GET /api/card-payments/:transactionId` (owner only).
- Admin: `GET /api/admin/card-payments?status=PAID_UNFULFILLED` lists paid-but-not-issued payments that need a manual refund.

Card payments store minor units, purpose `CARD_PURCHASE`, expiry, the Paystack reference and the held-stock flag. A card is issued only on a reconciled `SUCCESS` event whose amount, currency and transaction id match, and issuing is idempotent (repeat webhooks and browser returns create one purchase). Statuses: `PENDING`, `PAYMENT_INITIALIZED`, `SUCCESS`, `FAILED`, `EXPIRED`, `PAID_UNFULFILLED` (paid after the window closed and the card sold out) and `PAID_DUPLICATE` (paid twice for one purchase). The last two need a manual refund.
