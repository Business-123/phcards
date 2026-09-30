const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const DATA_FILE = process.env.PHANTOM_DATA_FILE || path.join(ROOT, 'data', 'phantom-cards.json');
const KYC_DOCUMENTS_DIR = process.env.KYC_DOCUMENTS_DIR || path.join(path.dirname(DATA_FILE), 'kyc-documents');
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.APP_URL || '';
const PAYSTACK_CURRENCY = process.env.PAYSTACK_CURRENCY || 'GHS';
// Phantom Cards talks to the Payment Hub directly (no separate payment microservice).
// The hub serves its merchant API under /api/v1; HUB_BASE_URL may be given either as the
// bare hub origin or with that suffix already attached — hubApiBase() normalizes both.
const HUB_BASE_URL = hubApiBase(process.env.HUB_BASE_URL);
const HUB_API_KEY = process.env.HUB_API_KEY || '';
const HUB_API_SECRET = process.env.HUB_API_SECRET || '';
const PAYMENT_SESSION_MS = Number(process.env.PAYMENT_SESSION_MINUTES || 15) * 60 * 1000;
const ADMIN_APPROVAL_TOKEN = process.env.ADMIN_APPROVAL_TOKEN || '';
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 30;
const RATE_WINDOW_MS = 1000 * 60 * 15;
const RATE_LIMITS = {
  '/api/auth/login': 20,
  '/api/auth/signup': 15,
  '/api/auth/forgot': 10,
  '/api/auth/reset': 10,
  '/api/auth/password': 10,
  '/api/auth/pin': 10,
  '/api/purchases': 30,
  '/api/claim-gift': 20,
  '/api/redemptions': 30,
  '/api/withdrawals': 20,
};
const rateBuckets = new Map();
// Withdrawal limit: nothing can be withdrawn until the redeemed balance reaches this.
// The cheapest paid card pays out more than this, so buying + redeeming a first card clears it.
let MIN_WITHDRAWAL = 100; // live value; admins can change it (db.settings)
const MIN_PURCHASED_CARDS_FOR_WITHDRAWAL = 3; // default; admins can change it live (db.settings)
const MAX_WITHDRAWAL_CARD_REQUIREMENT = 50;
function cleanCardRequirement(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_WITHDRAWAL_CARD_REQUIREMENT, Math.max(0, n)) : MIN_PURCHASED_CARDS_FOR_WITHDRAWAL;
}
function withdrawalCardRequirement(db) {
  // Older data files stored this as minRedeemedCardsForWithdrawal; it is now a purchased-card count.
  const s = db?.settings || {};
  return cleanCardRequirement(s.minPurchasedCardsForWithdrawal ?? s.minRedeemedCardsForWithdrawal ?? MIN_PURCHASED_CARDS_FOR_WITHDRAWAL);
}
let OPERATIONAL_CHARGE_RATE = 0.10;
let KYC_BYPASS_FEE = 70;

// ---- Admin-editable settings -------------------------------------------------
// Every value below can be changed by an admin (Settings page). They are stored in
// db.settings and copied into the live variables above on every load().
const SETTING_LIMITS = {
  minWithdrawal: { min: 1, max: 1000000 },
  minPurchasedCardsForWithdrawal: { min: 0, max: MAX_WITHDRAWAL_CARD_REQUIREMENT },
  dailyPurchaseLimit: { min: 1, max: 100 },
  tierPurchaseLimit: { min: 1, max: 100 },
  operationalChargeRate: { min: 0, max: 0.5 },
  kycBypassFee: { min: 1, max: 100000 },
  rewardMultiplierMin: { min: 0.1, max: 50 },
  rewardMultiplierMax: { min: 0.1, max: 50 },
};
function settingsDefaults() {
  return { minWithdrawal: 100, minPurchasedCardsForWithdrawal: MIN_PURCHASED_CARDS_FOR_WITHDRAWAL, dailyPurchaseLimit: 3, tierPurchaseLimit: 2, operationalChargeRate: 0.10, kycBypassFee: 70, rewardMultiplierMin: 3.52, rewardMultiplierMax: 4.42 };
}
function cleanSettings(raw) {
  const d = settingsDefaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, value, integer) => {
    const n = Number(value);
    const { min, max } = SETTING_LIMITS[key];
    if (value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return d[key];
    return integer ? n : Math.round(n * 10000) / 10000;
  };
  const out = {
    minWithdrawal: pick('minWithdrawal', src.minWithdrawal),
    minPurchasedCardsForWithdrawal: withdrawalCardRequirement({ settings: src }),
    dailyPurchaseLimit: pick('dailyPurchaseLimit', src.dailyPurchaseLimit, true),
    tierPurchaseLimit: pick('tierPurchaseLimit', src.tierPurchaseLimit, true),
    operationalChargeRate: pick('operationalChargeRate', src.operationalChargeRate),
    kycBypassFee: pick('kycBypassFee', src.kycBypassFee),
    rewardMultiplierMin: pick('rewardMultiplierMin', src.rewardMultiplierMin),
    rewardMultiplierMax: pick('rewardMultiplierMax', src.rewardMultiplierMax),
  };
  if (out.rewardMultiplierMin > out.rewardMultiplierMax) { out.rewardMultiplierMin = d.rewardMultiplierMin; out.rewardMultiplierMax = d.rewardMultiplierMax; }
  return out;
}
function applySettings(settings) {
  const s = cleanSettings(settings);
  MIN_WITHDRAWAL = s.minWithdrawal;
  DAILY_CARD_PURCHASE_LIMIT = s.dailyPurchaseLimit;
  TIER_PURCHASE_LIMIT = s.tierPurchaseLimit;
  OPERATIONAL_CHARGE_RATE = s.operationalChargeRate;
  KYC_BYPASS_FEE = s.kycBypassFee;
  REWARD_MULTIPLIER_MIN = s.rewardMultiplierMin;
  REWARD_MULTIPLIER_MAX = s.rewardMultiplierMax;
  return s;
}
function currentSettings(db) { return cleanSettings(db?.settings); }
const KYC_STATUS = {
  NOT_VERIFIED: 'NOT_VERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
};
const WITHDRAWAL_STATUS = {
  PENDING_KYC_VERIFICATION: 'PENDING_KYC_VERIFICATION',
  PENDING: 'pending',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};
const CODE_PATTERN = /^[A-Z]{2}[A-Z0-9]{12}$/;
const GHS_PER_USD = 12;
// Custom GHS charge for specific USD tiers that don't follow the flat 12:1 rate.
// The $4 tier is priced at 45 GHS instead of the standard 48 GHS (4 * 12).
const PRICE_OVERRIDES_GHS = { 4: 45 };
// The free gift is worth the same as a $1.50 card: its reward is that value x the usual reward multiplier.
const FREE_GIFT_VALUE_USD = 1.5;
const GHS_OVERRIDE_TO_USD = Object.fromEntries(Object.entries(PRICE_OVERRIDES_GHS).map(([usd, ghs]) => [ghs, Number(usd)]));
function ghsForUsd(usd) { return PRICE_OVERRIDES_GHS[usd] !== undefined ? PRICE_OVERRIDES_GHS[usd] : money(usd * GHS_PER_USD); }
function usdForGhs(priceGhs) { return GHS_OVERRIDE_TO_USD[priceGhs] !== undefined ? GHS_OVERRIDE_TO_USD[priceGhs] : money(priceGhs / GHS_PER_USD); }
// Price tiers are still used for labeling/reporting, but the daily purchase
// cap (see DAILY_CARD_PURCHASE_LIMIT) is now a flat total across all tiers.
const PRICE_TIERS = [
  { key: 'starter', min: 4, max: 5 },
  { key: 'core', min: 6, max: 10 },
  { key: 'premium', min: 11, max: 20 },
  { key: 'vault', min: 21, max: 50 },
];
let REWARD_MULTIPLIER_MIN = 3.52;
let REWARD_MULTIPLIER_MAX = 4.42;
const REWARD_BANDS = [
  { key: 'band-a', label: '$3 Band', minUsd: 3, maxUsd: 3 },
  { key: 'band-b', label: '$4-$5 Band', minUsd: 4, maxUsd: 5 },
  { key: 'band-c', label: '$6-$8 Band', minUsd: 6, maxUsd: 8 },
  { key: 'band-d', label: '$9-$12 Band', minUsd: 9, maxUsd: 12 },
  { key: 'band-e', label: '$13-$15 Band', minUsd: 13, maxUsd: 15 },
  { key: 'band-f', label: '$16-$20 Band', minUsd: 16, maxUsd: 20 },
  { key: 'band-g', label: '$21-$25 Band', minUsd: 21, maxUsd: 25 },
  { key: 'band-h', label: '$26-$30 Band', minUsd: 26, maxUsd: 30 },
  { key: 'band-i', label: '$31-$35 Band', minUsd: 31, maxUsd: 35 },
  { key: 'band-j', label: '$36-$40 Band', minUsd: 36, maxUsd: 40 },
  { key: 'band-k', label: '$41-$45 Band', minUsd: 41, maxUsd: 45 },
  { key: 'band-l', label: '$46-$50 Band', minUsd: 46, maxUsd: 50 },
];

function uid(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function reference(kind) { return `PH-${kind}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function uniqueReference(db, kind) {
  const existing = new Set([
    ...db.deposits,
    ...(db.cardPayments || []),
    ...db.purchases,
    ...db.withdrawals,
    ...(db.kycBypassPayments || []),
    ...db.transactions,
    ...db.receipts,
    ...(db.codes || []).map(x => ({ reference: x.redemptionReference })),
  ].flatMap(x => [x.reference, x.orderId, x.transactionId, x.paystackReference]).filter(Boolean));
  let value; do { value = reference(kind); } while (existing.has(value)); return value;
}
function uniqueCode(db) {
  let value;
  do {
    value = `${letters(2)}${token(6)}${token(6)}`;
  } while (db.codes.some(x => x.code === value));
  return value;
}
function letters(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let value = '';
  while (value.length < length) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}
function token(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = '';
  while (value.length < length) value += alphabet[crypto.randomInt(alphabet.length)];
  return value;
}
function stableToken(seed, length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = seeded(seed);
  let value = '';
  while (value.length < length) value += alphabet[Math.floor(random() * alphabet.length)];
  return value;
}
function rewardBandFor(priceGhs) {
  const priceUsd = usdForGhs(priceGhs);
  const band = REWARD_BANDS.find(item => priceUsd >= item.minUsd && priceUsd <= item.maxUsd) || REWARD_BANDS[REWARD_BANDS.length - 1];
  return { ...band, minRate: REWARD_MULTIPLIER_MIN, maxRate: REWARD_MULTIPLIER_MAX };
}
function rewardRangeForPrice(priceGhs) {
  const price = money(priceGhs);
  const band = rewardBandFor(price);
  return {
    min: money(price * band.minRate),
    max: money(price * band.maxRate),
    minRate: band.minRate,
    maxRate: band.maxRate,
  };
}
function rewardAllocationForPrice(priceGhs) {
  const multiplierMinor = crypto.randomInt(Math.round(REWARD_MULTIPLIER_MIN * 100), Math.round(REWARD_MULTIPLIER_MAX * 100) + 1);
  const rewardMultiplier = money(multiplierMinor / 100);
  return {
    rewardMultiplier,
    rewardAmount: money(money(priceGhs) * rewardMultiplier),
  };
}
function rewardForPrice(priceGhs) {
  return rewardAllocationForPrice(priceGhs).rewardAmount;
}
function validRewardMultiplier(value) {
  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier >= REWARD_MULTIPLIER_MIN && multiplier <= REWARD_MULTIPLIER_MAX;
}
function rewardMultiplierForAmount(rewardAmount, purchaseAmount) {
  const amount = Number(purchaseAmount);
  return amount > 0 ? money(Number(rewardAmount) / amount) : null;
}
function paystackEmailForUser(user) {
  const value = normalizeEmail(user?.email);
  if (!validGmail(value)) throw new Error('User does not have a valid account email for Paystack checkout.');
  return value;
}
function normalizeCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14); }
function money(value) { return Math.round(Number(value) * 100) / 100; }
function now() { return new Date().toISOString(); }
const GHANA_TIME_ZONE = 'Africa/Accra';
// Flat daily cap: a user may buy at most this many cards total per Ghana calendar
// day, across every price tier combined (no longer tracked per tier).
let DAILY_CARD_PURCHASE_LIMIT = 3;
// Permanent per-tier cap: once a user has bought this many cards inside one price tier
// (e.g. two cards anywhere in $4-$5), that tier is gone for that user for good.
// Admin-editable (Settings -> "Purchases before a tier closes").
let TIER_PURCHASE_LIMIT = 2;
function ghanaCalendarDate(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GHANA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function nextGhanaMidnightIso(value = Date.now()) {
  const current = new Date(value);
  const date = ghanaCalendarDate(current);
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0));
  return next.toISOString();
}
function purchasePriceKey(card) {
  const priceUsd = money(Number(card?.displayPriceUsd ?? usdForGhs(Number(card?.priceGhs || card?.price || 0))));
  const tier = PRICE_TIERS.find(t => priceUsd >= t.min && priceUsd <= t.max);
  return tier ? tier.key : priceUsd.toFixed(2);
}
function priceTierLabel(priceKey) {
  const tier = PRICE_TIERS.find(t => t.key === priceKey);
  return tier ? (tier.min === tier.max ? `$${tier.min}` : `$${tier.min}–$${tier.max}`) : `$${priceKey}`;
}
// Lifetime purchases a user has made in each price tier. Free gifts never count.
// Tier comes from what the user actually paid, so later price edits can't reopen a tier.
function tierKeyForPurchase(db, purchase) {
  const amount = Number(purchase.amount ?? purchase.amountPaid);
  if (Number.isFinite(amount) && amount > 0) return purchasePriceKey({ displayPriceUsd: usdForGhs(amount) });
  const card = db.cards.find(c => c.id === purchase.cardId);
  return card ? purchasePriceKey(card) : null;
}
function userTierPurchaseCounts(db, userId) {
  const counts = {};
  for (const purchase of db.purchases) {
    if (purchase.userId !== userId || purchase.isFreeGift) continue;
    const key = tierKeyForPurchase(db, purchase);
    if (key) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
// Tier keys this user has used up. They are removed from their shop permanently.
function closedTierKeys(db, userId) {
  const counts = userTierPurchaseCounts(db, userId);
  return PRICE_TIERS.map(t => t.key).filter(key => (counts[key] || 0) >= TIER_PURCHASE_LIMIT);
}
// Server-side guard for both purchase paths. In-flight checkouts count too, so two
// simultaneous payments can't slip past the cap.
function tierLimitReached(db, userId, priceKey) {
  const bought = userTierPurchaseCounts(db, userId)[priceKey] || 0;
  const pending = db.cardPayments.filter(item => item.userId === userId && item.priceKey === priceKey && cardPaymentIsActive(item)).length;
  return bought + pending >= TIER_PURCHASE_LIMIT;
}
function hash(value, salt = crypto.randomBytes(16).toString('hex')) { return new Promise((resolve, reject) => crypto.scrypt(value, salt, 64, (e, key) => e ? reject(e) : resolve(`${salt}:${key.toString('hex')}`))); }
async function passwordMatches(value, stored) { const [salt] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(await hash(value, salt)), Buffer.from(stored)); }
function normalizePhone(value) { return String(value || '').trim().replace(/[\s-]/g, ''); }
function validMobile(value) { return /^0\d{9}$/.test(value); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validGmail(value) { return /^[^\s@]+@gmail\.com$/i.test(value); }
function seeded(n) { let x = n >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeCards() {
  const categories = ['Digital', 'Gaming', 'Crypto', 'Collectible', 'Access', 'Exclusive', 'Limited', 'Rare'];
  const visuals = ['205,220,235', '176,124,255', '94,215,255', '245,166,35', '143,232,196', '255,106,145', '131,147,255', '255,210,122'];
  const usdPrices = [4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 35, 40, 45, 50];
  const random = seeded(0x5048414e);
  return Array.from({ length: 80 }, (_, i) => {
    const category = categories[i % categories.length]; const tier = ['Founders', 'Vault', 'Prime', 'Signature', 'Reserve', 'Crown'][Math.floor(i / categories.length) % 6];
    const usdPrice = usdPrices[i % usdPrices.length];
    const priceGhs = ghsForUsd(usdPrice);
    const seed = 0x5048414e + i;
    const serial = stableToken(seed, 8);
    const stock = i % 17 === 0 ? 0 : 8 + Math.floor(random() * 42);
    const band = rewardBandFor(priceGhs);
    const rewardRange = rewardRangeForPrice(priceGhs);
    const gift = i === 0 ? { isFreeGift: true, giftBaseValueGhs: ghsForUsd(FREE_GIFT_VALUE_USD), description: 'A free welcome gift — claim it at no cost. Each account may claim it once.' } : {};
    const card = { id: `CARD-${String(i + 1).padStart(4, '0')}`, seed, serial, title: `${category} ${tier} ${serial.slice(0, 4)}`, category, price: priceGhs, priceGhs, displayPriceUsd: usdPrice, stock, active: stock > 0, series: `${category.slice(0, 3).toUpperCase()}-${serial.slice(0, 5)}`, edition: serial.slice(5), rgb: visuals[i % visuals.length], rewardBand: band.key, rewardMinRate: band.minRate, rewardMaxRate: band.maxRate, rewardMinAmount: rewardRange.min, rewardMaxAmount: rewardRange.max, description: `${category} ${tier.toLowerCase()} sealed card with a ${band.label.toLowerCase()} reward band.` };
    return i === 0 ? { ...card, ...gift, price: 0, priceGhs: 0, displayPriceUsd: 0, stock: 999999, active: true } : card;
  });
}
function blankDb() { return { version: 5, cards: makeCards(), users: [], sessions: [], adminSessions: [], adminAuditLogs: [], deposits: [], cardPayments: [], purchases: [], dailyPurchaseCounts: [], codes: [], methods: [], withdrawals: [], transactions: [], receipts: [], passwordResets: [], kycBypassPayments: [], settings: settingsDefaults() }; }
function syncCardCatalog(cards) {
  const generated = makeCards();
  const generatedMap = new Map(generated.map(card => [card.id, card]));
  return (Array.isArray(cards) && cards.length ? cards : generated).map(card => {
    const template = generatedMap.get(card.id) || card;
    // A free-gift card is never priced or restocked like a normal card: it always costs
    // nothing and is always available to claim, no matter what the generated template or
    // any stray stock number on disk says. Its reward band is still derived from a fixed
    // "value" (giftBaseValueGhs) so the potential-redeem display stays meaningful.
    if (card.isFreeGift || card.id === 'CARD-0001') {
      const giftBaseValueGhs = ghsForUsd(FREE_GIFT_VALUE_USD);
      const band = rewardBandFor(giftBaseValueGhs);
      const rewardRange = rewardRangeForPrice(giftBaseValueGhs);
      return {
        ...card,
        isFreeGift: true,
        description: card.isFreeGift ? card.description : template.description,
        giftBaseValueGhs,
        price: 0,
        priceGhs: 0,
        displayPriceUsd: 0,
        stock: Number.isFinite(Number(card.stock)) && Number(card.stock) > 0 ? Math.max(1, Math.trunc(Number(card.stock))) : 999999,
        active: true,
        rewardBand: band.key,
        rewardMinRate: band.minRate,
        rewardMaxRate: band.maxRate,
        rewardMinAmount: rewardRange.min,
        rewardMaxAmount: rewardRange.max,
      };
    }
    // A tier with an explicit override (see PRICE_OVERRIDES_GHS) always charges the
    // overridden amount, even for a card that already exists in a live database with
    // its old price saved on disk — otherwise a price change would only ever apply to
    // brand-new cards and never correct one that was already sold under the old price.
    //
    // The override must be decided from the card's OWN current USD price, not from a
    // freshly regenerated template's guess at that ID's price. makeCards() assigns USD
    // prices purely by array position, so if the tier layout ever shifts, a card's ID
    // can end up mapped to a different position-based price than what it is actually
    // listed and sold at — silently skipping the override for that specific card forever,
    // even though every other card in the same $4 tier gets corrected correctly.
    const currentUsd = card.displayPriceUsd !== undefined ? card.displayPriceUsd : template.displayPriceUsd;
    const overriddenGhs = currentUsd !== undefined && PRICE_OVERRIDES_GHS[currentUsd] !== undefined ? PRICE_OVERRIDES_GHS[currentUsd] : null;
    const priceGhs = overriddenGhs !== null ? overriddenGhs : money(card.priceGhs || card.price || template.priceGhs);
    const seed = card.seed || template.seed || 0x5048414e;
    const band = rewardBandFor(priceGhs);
    const stock = Number.isFinite(Number(card.stock)) ? Math.max(0, Math.trunc(Number(card.stock))) : template.stock;
    const serial = card.serial && !/#\d+/.test(String(card.serial)) ? card.serial : (template.serial || stableToken(seed, 8));
    return {
      ...card,
      seed,
      serial,
      title: template.title && !/#\d+/.test(String(template.title)) ? template.title : `${card.category || template.category} ${serial.slice(0, 4)}`,
      series: template.series || `${String(card.category || template.category || 'Card').slice(0, 3).toUpperCase()}-${serial.slice(0, 5)}`,
      edition: template.edition || serial.slice(5),
      description: template.description || `${card.category || template.category || 'Digital'} sealed card with a ${band.label.toLowerCase()} reward band.`,
      price: priceGhs,
      priceGhs,
      displayPriceUsd: usdForGhs(priceGhs),
      stock,
      active: stock > 0,
      rewardBand: band.key,
      rewardRate: undefined,
      rewardAmount: undefined,
      rewardMinRate: band.minRate,
      rewardMaxRate: band.maxRate,
      rewardMinAmount: rewardRangeForPrice(priceGhs).min,
      rewardMaxAmount: rewardRangeForPrice(priceGhs).max,
    };
  });
}
function migrateMoneyLedger(clean) {
  const cardMap = new Map(clean.cards.map(card => [card.id, card]));
  const purchaseMap = new Map(clean.purchases.map(purchase => [purchase.id, purchase]));
  clean.purchases.forEach(purchase => {
    const card = cardMap.get(purchase.cardId);
    const amountPaid = money(purchase.amountPaid ?? purchase.amount ?? card?.priceGhs ?? 0);
    purchase.amountPaid = amountPaid;
    purchase.amount = amountPaid;
    if (purchase.rewardAmount === undefined && card?.rewardAmount === undefined) {
      const allocation = rewardAllocationForPrice(amountPaid);
      purchase.rewardAmount = allocation.rewardAmount;
      purchase.rewardMultiplier = allocation.rewardMultiplier;
    } else {
      purchase.rewardAmount = money(purchase.rewardAmount ?? card?.rewardAmount);
      purchase.rewardMultiplier = purchase.rewardMultiplier ?? rewardMultiplierForAmount(purchase.rewardAmount, amountPaid);
    }
  });
  clean.codes.forEach(code => {
    const card = cardMap.get(code.cardId);
    const purchase = purchaseMap.get(code.purchaseId);
    const purchaseAmount = money(code.purchaseAmount ?? purchase?.amountPaid ?? card?.priceGhs ?? code.amount ?? 0);
    const rewardAmount = money(code.rewardAmount ?? purchase?.rewardAmount ?? card?.rewardAmount ?? rewardForPrice(purchaseAmount));
    code.code = normalizeCode(code.code);
    code.purchaseAmount = purchaseAmount;
    code.rewardAmount = rewardAmount;
    code.rewardMultiplier = code.rewardMultiplier ?? purchase?.rewardMultiplier ?? rewardMultiplierForAmount(rewardAmount, purchaseAmount);
    code.amount = rewardAmount;
  });
  clean.transactions.forEach(tx => {
    if (tx.reason === 'Card purchase') {
      const purchase = clean.purchases.find(item => item.reference === tx.reference || item.orderId === tx.related?.orderId);
      if (purchase) tx.related = { ...(tx.related || {}), purchaseAmount: purchase.amountPaid, rewardAmount: purchase.rewardAmount, rewardMultiplier: purchase.rewardMultiplier };
    }
    if (tx.reason === 'Redeemed code') {
      const code = clean.codes.find(item => item.redemptionReference === tx.reference || item.code === tx.related?.code);
      if (code) {
        tx.amount = code.rewardAmount;
        tx.related = { ...(tx.related || {}), purchaseAmount: code.purchaseAmount, rewardAmount: code.rewardAmount, rewardMultiplier: code.rewardMultiplier };
      }
    }
  });
  clean.receipts.forEach(rcpt => {
    if (rcpt.type === 'purchase') {
      const purchase = clean.purchases.find(item => item.reference === rcpt.reference || item.orderId === rcpt.related?.orderId);
      if (purchase) rcpt.related = { ...(rcpt.related || {}), purchaseAmount: purchase.amountPaid, rewardAmount: purchase.rewardAmount, rewardMultiplier: purchase.rewardMultiplier };
    }
    if (rcpt.type === 'redemption') {
      const code = clean.codes.find(item => item.redemptionReference === rcpt.reference || item.code === rcpt.related?.code);
      if (code) {
        rcpt.amount = code.rewardAmount;
        rcpt.related = { ...(rcpt.related || {}), purchaseAmount: code.purchaseAmount, rewardAmount: code.rewardAmount, rewardMultiplier: code.rewardMultiplier };
      }
    }
  });
  clean.users.forEach(user => {
    user.walletBalance = 0;
    user.redeemedBalance = 0;
    user.kycStatus = user.kycStatus || KYC_STATUS.NOT_VERIFIED;
  });
  clean.transactions.forEach(tx => {
    if (!transactionAffectsBalance(tx)) return;
    const user = clean.users.find(item => item.id === tx.userId);
    if (!user) return;
    const key = tx.account === 'wallet' ? 'walletBalance' : 'redeemedBalance';
    const delta = tx.type === 'credit' ? tx.amount : -tx.amount;
    user[key] = money(Math.max(0, user[key] + delta));
  });
}
function redeemedCardsCount(db, userId) {
  return db.codes.filter(code => code.userId === userId && code.status === 'redeemed').length;
}
// Cards the user actually paid for. The free welcome gift never counts.
function purchasedCardsCount(db, userId) {
  return db.purchases.filter(item => item.userId === userId && !item.isFreeGift && Number(item.amountPaid ?? item.amount ?? 0) > 0).length;
}
function normalizeWithdrawalRecord(withdrawal) {
  const requestedAmount = money(withdrawal.requestedAmount ?? withdrawal.amount ?? 0);
  const isRefund = Boolean(withdrawal.isRefund || withdrawal.refundType === 'KYC_FEE_REFUND');
  const operationalCharge = money(withdrawal.operationalCharge ?? (isRefund ? 0 : requestedAmount * OPERATIONAL_CHARGE_RATE));
  const actualAmount = money(withdrawal.actualAmount ?? (isRefund ? requestedAmount : Math.max(0, requestedAmount - operationalCharge)));
  withdrawal.requestedAmount = requestedAmount;
  withdrawal.operationalCharge = operationalCharge;
  withdrawal.actualAmount = actualAmount;
  withdrawal.amount = requestedAmount;
  withdrawal.isRefund = isRefund;
  withdrawal.refundType = isRefund ? 'KYC_FEE_REFUND' : (withdrawal.refundType || null);
  withdrawal.refundForWithdrawalId = withdrawal.refundForWithdrawalId || null;
  withdrawal.refundForWithdrawalReference = withdrawal.refundForWithdrawalReference || null;
  withdrawal.refundedAt = withdrawal.refundedAt || null;
  withdrawal.kycRequired = Boolean(withdrawal.kycRequired);
  withdrawal.kycBypassUsed = Boolean(withdrawal.kycBypassUsed);
  withdrawal.kycBypassFee = money(withdrawal.kycBypassFee || 0);
  withdrawal.kycBypassRefunded = Boolean(withdrawal.kycBypassRefunded);
  withdrawal.kycBypassRefundAmount = money(withdrawal.kycBypassRefundAmount || 0);
  withdrawal.kycBypassRefundReference = withdrawal.kycBypassRefundReference || null;
  withdrawal.kycBypassRefundedAt = withdrawal.kycBypassRefundedAt || null;
  withdrawal.paymentStatus = withdrawal.paymentStatus || 'not_required';
  return withdrawal;
}
function withdrawalIsHeld(status) {
  return [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.APPROVED, WITHDRAWAL_STATUS.PROCESSING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION].includes(status);
}
// Withdrawals are no longer parked on "pending KYC": the withdrawal is only created
// once the KYC fee is paid. Any older withdrawal still stuck in PENDING_KYC_VERIFICATION
// is removed together with its ledger transaction and receipt. Balances are rebuilt from
// the ledger right after this runs (see migrateMoneyLedger), so removing the held debit
// is what gives the user their money back. Idempotent: a second run finds nothing.
function purgePendingKycWithdrawals(clean) {
  const stuck = clean.withdrawals.filter(item => !item.isRefund && item.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION);
  if (!stuck.length) return 0;
  const ids = new Set(stuck.map(item => item.id));
  const refs = new Set(stuck.map(item => item.reference));
  clean.withdrawals = clean.withdrawals.filter(item => !ids.has(item.id));
  clean.transactions = clean.transactions.filter(item => !refs.has(item.reference));
  clean.receipts = clean.receipts.filter(item => !refs.has(item.reference));
  console.log('[kyc:pending-withdrawals-reversed]', stuck.length, stuck.map(item => `${item.reference}:${money(item.requestedAmount)}`).join(','));
  return stuck.length;
}
function normalizeDb(db) {
  const clean = { ...blankDb(), ...(db || {}) };
  for (const key of ['users', 'sessions', 'adminSessions', 'adminAuditLogs', 'deposits', 'cardPayments', 'purchases', 'dailyPurchaseCounts', 'codes', 'methods', 'withdrawals', 'transactions', 'receipts', 'passwordResets', 'kycBypassPayments']) {
    if (!Array.isArray(clean[key])) clean[key] = [];
  }
  clean.settings = cleanSettings(clean.settings);
  applySettings(clean.settings); // must run before cards/withdrawals are normalised: they read the live values
  clean.cards = syncCardCatalog(clean.cards);
  clean.withdrawals.forEach(withdrawal => normalizeWithdrawalRecord(withdrawal));
  // Older versions represented the KYC fee refund as a redeemed-balance
  // credit. Convert that legacy ledger entry into an external refund and
  // materialize the missing withdrawal-history record before rebuilding
  // balances, so loading old data cannot re-credit Redeemed Balance.
  clean.transactions.filter(tx => tx.reason === 'KYC bypass fee refund' || tx.related?.transactionType === 'REFUND').forEach(tx => {
    const related = tx.related || {};
    const original = clean.withdrawals.find(item => item.id === related.withdrawalId || item.reference === related.withdrawalReference);
    tx.account = 'external';
    tx.status = 'refunded';
    tx.entryType = 'REFUND';
    tx.reason = 'KYC Fee Refund';
    tx.related = { ...related, refund: true, transactionType: 'REFUND', withdrawalId: related.withdrawalId || original?.id || null, withdrawalReference: related.withdrawalReference || original?.reference || null };
    if (original && !clean.withdrawals.some(item => item.reference === tx.reference && item.isRefund)) {
      clean.withdrawals.push(normalizeWithdrawalRecord({
        id: uid('wdl_refund'), userId: tx.userId, methodId: original.methodId,
        amount: tx.amount, requestedAmount: tx.amount, operationalCharge: 0,
        actualAmount: tx.amount, reference: tx.reference, status: 'refunded',
        isRefund: true, refundType: 'KYC_FEE_REFUND',
        refundForWithdrawalId: original.id, refundForWithdrawalReference: original.reference,
        refundedAt: tx.createdAt, createdAt: tx.createdAt,
      }));
    }
  });
  clean.receipts.filter(rcpt => rcpt.type === 'kyc_bypass_refund' || rcpt.related?.transactionType === 'REFUND').forEach(rcpt => {
    rcpt.account = 'external';
    rcpt.status = 'refunded';
    rcpt.related = { ...(rcpt.related || {}), refund: true, transactionType: 'REFUND' };
  });
  purgePendingKycWithdrawals(clean);
  migrateMoneyLedger(clean);
  rebuildDailyPurchaseCounts(clean);
  clean.users.forEach(user => {
    user.walletBalance = money(user.walletBalance || 0);
    user.redeemedBalance = money(user.redeemedBalance || 0);
    user.kycStatus = Object.values(KYC_STATUS).includes(user.kycStatus) ? user.kycStatus : KYC_STATUS.NOT_VERIFIED;
    user.kycVerifiedAt = user.kycStatus === KYC_STATUS.VERIFIED ? (user.kycVerifiedAt || now()) : null;
    user.canBuyWithBalance = Boolean(user.canBuyWithBalance);
    user.blocked = Boolean(user.blocked);
    user.blockedAt = user.blocked ? (user.blockedAt || now()) : null;
    user.blockedReason = user.blocked ? String(user.blockedReason || '').trim().slice(0, 500) : null;
  });
  return clean;
}
function rebuildDailyPurchaseCounts(db) {
  const counts = new Map();
  for (const purchase of db.purchases) {
    if (!purchase.userId || purchase.isFreeGift) continue; // free gifts never use up the daily buy limit
    const date = ghanaCalendarDate(purchase.createdAt || Date.now());
    const key = `${purchase.userId}:${date}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  db.dailyPurchaseCounts = [...counts.entries()].map(([key, count]) => {
    const [userId, purchaseDate] = key.split(':');
    return { id: `daily_${userId}_${purchaseDate}`, userId, purchaseDate, count };
  });
}
function load() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) { const db = blankDb(); save(db); return db; }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A half-written file (e.g. the process was killed mid-save during a redeploy)
    // must never crash the server or silently wipe user data. Quarantine the broken
    // file next to itself for forensics/recovery, and start clean rather than looping
    // a crash on every single request from here on.
    const quarantinePath = `${DATA_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, quarantinePath); } catch (copyError) { console.error('[db:quarantine:failed]', copyError.message || copyError); }
    console.error('[db:corrupt] Data file was not valid JSON and could not be loaded.');
    console.error(`[db:corrupt] A copy of the broken file was saved to: ${quarantinePath}`);
    console.error(`[db:corrupt] ${error.message}`);
    const db = blankDb();
    save(db);
    return db;
  }
  const db = normalizeDb(parsed);
  save(db);
  return db;
}
// Writes are atomic: write to a temp file on the same volume, then rename over the
// real file. A rename is a single filesystem operation, so a process kill (e.g. the
// SIGTERM Railway sends on every redeploy) can never leave a half-written, corrupted
// data file behind the way writing directly to DATA_FILE could.
function save(db) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(DATA_FILE)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DATA_FILE);
}
function receipt(db, { userId, type, amount, account, reference: ref, status = 'completed', related = {} }) { if (db.receipts.some(x => x.reference === ref)) return db.receipts.find(x => x.reference === ref); const item = { id: uid('rcpt'), userId, type, amount: money(amount), account, reference: ref, status, related, createdAt: now() }; db.receipts.push(item); return item; }
function transaction(db, { userId, type, entryType = null, amount, account, reference: ref, status = 'completed', reason, related = {} }) { if (db.transactions.some(x => x.reference === ref)) return db.transactions.find(x => x.reference === ref); const item = { id: uid('txn'), userId, type, ...(entryType ? { entryType } : {}), amount: money(amount), account, reference: ref, status, reason, related, createdAt: now() }; db.transactions.push(item); return item; }
function transactionAffectsBalance(tx) {
  if (!['wallet', 'redeemed'].includes(tx.account)) return false;
  if (['completed', 'success'].includes(tx.status)) return true;
  return tx.account === 'redeemed' && tx.type === 'debit' && /withdraw/i.test(tx.reason || '') && withdrawalIsHeld(tx.status);
}
function persistKycDocuments(userId, documents) {
  const userDirectory = path.join(KYC_DOCUMENTS_DIR, String(userId));
  fs.mkdirSync(userDirectory, { recursive: true });
  return documents.map(document => {
    const content = String(document.content || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('One of the uploaded documents is invalid.');
    const binary = Buffer.from(content, 'base64');
    if (!binary.length || binary.length !== Number(document.size) || binary.length > 5 * 1024 * 1024) throw new Error('One of the uploaded documents is invalid.');
    const storageKey = `${uid('kyc')}.bin`;
    fs.writeFileSync(path.join(userDirectory, storageKey), binary, { flag: 'wx', mode: 0o600 });
    return { name: String(document.name).trim().slice(0, 180), type: document.type, size: binary.length, storageKey };
  });
}
function balance(user, account, amount) { const key = account === 'wallet' ? 'walletBalance' : 'redeemedBalance'; const next = money(user[key] + amount); if (next < 0) throw new Error('Balance cannot be negative'); user[key] = next; }
function cookie(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split('='))); }
function sessionCookie(token, req, maxAge = SESSION_MAX_AGE / 1000) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function clearSessionCookie(req) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
function isLocalHost(hostname = '') {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(String(hostname).toLowerCase());
}
function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}
function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  if (forwardedHost) return `${protocol}://${forwardedHost}`;
  if (APP_BASE_URL) {
    try {
      return new URL(APP_BASE_URL).origin;
    } catch {
      return APP_BASE_URL;
    }
  }
  return `http://127.0.0.1:${PORT}`;
}
function appBaseUrlForRoute(req) {
  return APP_BASE_URL || requestOrigin(req);
}
// Where the hub's OWN /return/:reference hop should land the browser back on this
// site (before this site does its own reconciliation and sends the browser on to its
// final destination). This must be reachable from the customer's browser, so it has to
// prefer the browser's own reported origin (window.location.origin, sent as
// returnOrigin) over APP_BASE_URL/requestOrigin() — those can be wrong (APP_BASE_URL
// unset, or a proxy not forwarding x-forwarded-host) and, unlike the final callbackUrl
// below, this one previously never fell back to the browser's origin at all, so a
// misconfigured APP_BASE_URL silently sent every customer to an unreachable URL
// (even localhost) right after they paid.
function hubReturnOrigin(req, browserOrigin = '') {
  return normalizeOrigin(browserOrigin) || appBaseUrlForRoute(req);
}
function userFor(req, db) { const token = cookie(req).phantom_session; const session = db.sessions.find(s => s.token === token && s.expiresAt > Date.now()); return session && db.users.find(u => u.id === session.userId); }
function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
}
function rateLimit(req, res, pathname) {
  const limit = RATE_LIMITS[pathname];
  if (!limit) return false;
  const key = `${clientKey(req)}:${pathname}`;
  const nowMs = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: nowMs + RATE_WINDOW_MS };
  if (bucket.resetAt <= nowMs) {
    bucket.count = 0;
    bucket.resetAt = nowMs + RATE_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count <= limit) return false;
  json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' }, { 'retry-after': String(Math.ceil((bucket.resetAt - nowMs) / 1000)) });
  return true;
}
function originAllowed(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  if (req.url.startsWith('/api/webhooks/hub')) return true;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  return normalizeOrigin(origin) === normalizeOrigin(requestOrigin(req));
}
function publicState(db, user) {
  const userId = user.id; const cardMap = new Map(db.cards.map(c => [c.id, c]));
  // Only ever show cards from the $4-and-up tiers in the shop. This is a safety net that
  // hides any card priced below the lowest official tier (e.g. a stray $3 card created by
  // a past manual edit) without deleting the record, so purchase/redemption history for it
  // stays intact.
  // A tier the user has bought TIER_PURCHASE_LIMIT cards from never comes back for them.
  const closedTiers = closedTierKeys(db, userId);
  const cards = db.cards.filter(c => c.isFreeGift || (Number(c.displayPriceUsd) >= 4 && !closedTiers.includes(purchasePriceKey(c)))).map(publicCard);
  const codes = db.codes.filter(x => x.userId === userId).map(x => publicCode(x, cardMap.get(x.cardId)));
  const txs = db.transactions.filter(x => x.userId === userId).map(publicTransaction).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const receipts = db.receipts.filter(x => x.userId === userId).map(publicReceipt).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const purchases = db.purchases.filter(x => x.userId === userId).map(publicPurchase).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const withdrawals = db.withdrawals.filter(x => x.userId === userId).map(publicWithdrawal).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const purchaseDate = ghanaCalendarDate();
  const dailyRecord = db.dailyPurchaseCounts.find(item => item.userId === userId && item.purchaseDate === purchaseDate);
  const dailyPurchaseCount = Math.min(Number(dailyRecord?.count) || 0, DAILY_CARD_PURCHASE_LIMIT);
  return {
    user: { id: user.id, name: user.name, email: user.email || '', phone: user.phone, contactEmailCapturedAt: user.contactEmailCapturedAt || null, createdAt: user.createdAt, walletBalance: user.walletBalance, redeemedBalance: user.redeemedBalance, hasPin: Boolean(user.pinHash), kycStatus: user.kycStatus || KYC_STATUS.NOT_VERIFIED, kycVerifiedAt: user.kycVerifiedAt || null, lifetimeRedeemedCards: redeemedCardsCount(db, user.id), lifetimePurchasedCards: purchasedCardsCount(db, user.id), canBuyWithBalance: Boolean(user.canBuyWithBalance) },
    cards, codes, methods: db.methods.filter(x => x.userId === userId), transactions: txs, receipts, purchases, withdrawals,
    // Flat daily total across all tiers, not per price tier.
    withdrawalCardRequirement: withdrawalCardRequirement(db),
    kycBypassFee: KYC_BYPASS_FEE,
    operationalChargeRate: OPERATIONAL_CHARGE_RATE,
    rewardMultiplierMin: REWARD_MULTIPLIER_MIN,
    rewardMultiplierMax: REWARD_MULTIPLIER_MAX,
    minWithdrawal: MIN_WITHDRAWAL,
    purchaseLimits: { date: purchaseDate, max: DAILY_CARD_PURCHASE_LIMIT, count: dailyPurchaseCount, resetAt: nextGhanaMidnightIso(), tierMax: TIER_PURCHASE_LIMIT },
    closedTiers,
  };
}
function publicCard(card) {
  const { rewardAmount, rewardRate, ...safe } = card;
  return safe;
}
function publicPurchase(purchase) {
  const { userId, idempotencyKey, rewardAmount, rewardMultiplier, ...safe } = purchase;
  return safe;
}
function publicWithdrawal(withdrawal) {
  return { ...withdrawal };
}
function publicCode(code, card) {
  const redeemed = code.status === 'redeemed';
  // A redeem code is a secret until its owner explicitly asks to reveal it.
  // Never include it (or the owner id) in ordinary account-state responses.
  const { code: secretCode, userId, rewardAmount, rewardMultiplier, amount, ...safe } = code;
  return {
    ...safe,
    ...(redeemed ? { amount, rewardAmount, rewardMultiplier } : {}),
    card: card ? publicCard(card) : undefined,
  };
}
function sanitizeRelated(related = {}, revealReward = false) {
  const safe = { ...related };
  delete safe.code;
  if (!revealReward) delete safe.rewardAmount;
  return safe;
}
function publicTransaction(tx) {
  return { ...tx, related: sanitizeRelated(tx.related, tx.reason === 'Redeemed code') };
}
function publicReceipt(rcpt) {
  return { ...rcpt, related: sanitizeRelated(rcpt.related, rcpt.type === 'redemption') };
}
function purchasePayload(purchase, code, receipt) {
  return {
    purchase: publicPurchase(purchase),
    code: publicCode(code),
    receipt: publicReceipt(receipt),
  };
}
function json(res, status, data, extra = {}) { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(data)); }
function fail(res, status, message) { json(res, status, { error: message }); }
async function body(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('Invalid JSON body'); } }
async function rawBody(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function safeEqual(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
// The hub serves its merchant API under /api/v1. HUB_BASE_URL may be given as either the
// bare hub origin (https://hub.example.com) or with the prefix already attached; both
// resolve to the same base.
function hubApiBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/api\/v1$/.test(base) ? base : `${base}/api/v1`;
}
function hubSignature(secret, raw) { return crypto.createHmac('sha512', secret).update(raw).digest('hex'); }
// Every call Phantom Cards makes TO the hub, per the hub's own auth contract:
// x-api-key identifies this merchant, x-signature is an HMAC-SHA512 of the exact raw
// JSON body (or an empty string for GET) using the merchant's api secret.
async function hubCall(method, urlPath, payload) {
  if (!HUB_BASE_URL || !HUB_API_KEY || !HUB_API_SECRET) throw new Error('Hub payment service is not configured.');
  const raw = method === 'GET' ? '' : JSON.stringify(payload || {});
  const response = await fetch(`${HUB_BASE_URL}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': HUB_API_KEY, 'x-signature': hubSignature(HUB_API_SECRET, raw) },
    body: method === 'GET' ? undefined : raw,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.status) throw new Error(result.message || 'Hub request failed.');
  return result.data;
}
// Verifies a webhook the hub sends back TO Phantom Cards: HMAC-SHA512 of the exact raw
// body using this merchant's own api secret, in header x-hub-signature.
function verifyHubWebhookSignature(rawBody, signatureHeader) {
  if (!HUB_API_SECRET || !signatureHeader) return false;
  return safeEqual(signatureHeader, hubSignature(HUB_API_SECRET, rawBody));
}
function validKycBypass(payment, user) { return payment && user && payment.userId === user.id && Number(payment.amount) > 0 && payment.currency === PAYSTACK_CURRENCY; }
// ---- Direct card payments -------------------------------------------------------
// A card is paid for at the moment the customer taps BUY: the app opens a hub checkout
// for exactly the card price, holds one unit of stock for the payment window, and
// creates the purchase + redeem code only once the hub confirms the charge.
const CARD_PAYMENT_ACTIVE = ['PENDING', 'PAYMENT_INITIALIZED'];
function cardPaymentIsActive(payment) { return CARD_PAYMENT_ACTIVE.includes(payment.status) && Date.parse(payment.expiresAt) > Date.now(); }
function publicCardPayment(payment) {
  return { transactionId: payment.transactionId, reference: payment.reference, status: payment.status, amount: payment.amount, cardId: payment.cardId, checkoutUrl: payment.authorizationUrl || null, expiresAt: payment.expiresAt, purchaseId: payment.purchaseId || null };
}
function releaseCardReservation(db, payment) {
  if (!payment.stockReserved) return;
  const card = db.cards.find(item => item.id === payment.cardId);
  if (card) { const soldOut = card.stock < 1; card.stock++; if (soldOut) card.active = true; }
  payment.stockReserved = false;
}
function hasExpiredCardPayments(db) {
  return db.cardPayments.some(item => CARD_PAYMENT_ACTIVE.includes(item.status) && Date.parse(item.expiresAt) <= Date.now());
}
// Abandoned checkouts must not hold stock forever.
function sweepCardPayments(db) {
  let changed = false;
  for (const payment of db.cardPayments) {
    if (CARD_PAYMENT_ACTIVE.includes(payment.status) && Date.parse(payment.expiresAt) <= Date.now()) {
      payment.status = 'EXPIRED'; payment.updatedAt = now(); releaseCardReservation(db, payment); changed = true;
    }
  }
  if (changed) save(db);
  return changed;
}
// Turns a confirmed charge into the purchase. Idempotent: webhook + browser return can both call it.
function completeCardPayment(db, payment, provider) {
  if (payment.purchaseId) return db.purchases.find(item => item.id === payment.purchaseId) || null;
  const user = db.users.find(item => item.id === payment.userId);
  const card = db.cards.find(item => item.id === payment.cardId);
  if (!user || !card) throw new Error('Card payment user or card was not found.');
  if (['PAID_UNFULFILLED', 'PAID_DUPLICATE'].includes(payment.status)) return null;
  if (db.purchases.some(item => item.userId === user.id && item.idempotencyKey === payment.idempotencyKey)) {
    releaseCardReservation(db, payment);
    payment.status = 'PAID_DUPLICATE'; payment.verifiedAt = now(); payment.updatedAt = now();
    console.error('[card-payment] paid twice for one purchase key; needs manual refund', payment.transactionId);
    return null;
  }
  if (!payment.stockReserved) {
    // The payment succeeded after its window closed and the held unit was released.
    if (card.stock < 1) {
      payment.status = 'PAID_UNFULFILLED'; payment.verifiedAt = now(); payment.updatedAt = now();
      console.error('[card-payment] paid after expiry and card is sold out; needs manual refund', payment.transactionId);
      return null;
    }
    card.stock--; card.active = card.stock > 0; payment.stockReserved = true;
  }
  const purchaseDate = ghanaCalendarDate();
  const priceKey = purchasePriceKey(card);
  const dailyRecord = db.dailyPurchaseCounts.find(item => item.userId === user.id && item.purchaseDate === purchaseDate);
  const orderId = uniqueReference(db, 'ORD');
  const purchaseReference = uniqueReference(db, 'PUR');
  const code = uniqueCode(db);
  const purchaseAmount = money(payment.amount);
  const reward = rewardAllocationForPrice(purchaseAmount);
  const purchase = { id: uid('order'), orderId, reference: purchaseReference, userId: user.id, cardId: card.id, idempotencyKey: payment.idempotencyKey, amount: purchaseAmount, amountPaid: purchaseAmount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, paymentReference: payment.transactionId, status: 'sealed', createdAt: now() };
  db.purchases.push(purchase);
  if (dailyRecord) dailyRecord.count = Number(dailyRecord.count || 0) + 1;
  else db.dailyPurchaseCounts.push({ id: uid('daily'), userId: user.id, purchaseDate, count: 1 });
  db.codes.push({ id: uid('code'), code, userId: user.id, cardId: card.id, orderId, purchaseId: purchase.id, amount: reward.rewardAmount, purchaseAmount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, status: 'unused', createdAt: now(), redeemedAt: null, redemptionReference: null });
  const related = { cardId: card.id, orderId, code, purchaseAmount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, provider, paymentReference: payment.transactionId, paystackReference: payment.paystackReference };
  transaction(db, { userId: user.id, type: 'debit', amount: purchaseAmount, account: 'external', reference: purchaseReference, reason: 'Card purchase', related });
  receipt(db, { userId: user.id, type: 'purchase', amount: purchaseAmount, account: 'external', reference: purchaseReference, related });
  payment.status = 'SUCCESS'; payment.verifiedAt = now(); payment.updatedAt = now(); payment.purchaseId = purchase.id;
  console.log('[purchase:complete]', orderId, { purchaseAmount, purchaseDate, provider });
  return purchase;
}
// Reconciles a card payment directly against the hub (never trusts the browser's
// redirect alone) and returns a [status, body] pair for the /complete endpoint.
async function reconcileCardPayment(reference) {
  const before = load();
  const known = before.cardPayments.find(item => item.paystackReference === reference);
  if (!known) return [404, { error: 'Payment session was not found.' }];
  let verified = null;
  if (!known.purchaseId && !['PAID_UNFULFILLED', 'PAID_DUPLICATE'].includes(known.status)) {
    verified = await hubCall('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }
  return withPurchaseMutation(async () => {
    const db = load();
    const payment = db.cardPayments.find(item => item.paystackReference === reference);
    if (!payment) return [404, { error: 'Payment session was not found.' }];
    sweepCardPayments(db);
    if (verified) {
      if (Math.round(Number(verified.amount) * 100) !== payment.amountMinor || verified.currency !== payment.currency) {
        return [409, { error: 'Payment details did not reconcile.' }];
      }
      if (verified.status === 'SUCCESS') completeCardPayment(db, payment, 'hub');
      else if (['FAILED', 'ABANDONED'].includes(verified.status) && CARD_PAYMENT_ACTIVE.includes(payment.status)) {
        payment.status = 'FAILED'; payment.updatedAt = now(); releaseCardReservation(db, payment);
      }
      save(db);
    }
    if (payment.status === 'SUCCESS') return [200, { redirect: payment.callbackUrl }];
    const origin = payment.callbackUrl ? new URL(payment.callbackUrl).origin : (APP_BASE_URL || '');
    if (['FAILED', 'EXPIRED'].includes(payment.status)) return [200, { redirect: `${origin}/?payment=${payment.status.toLowerCase()}` }];
    if (['PAID_UNFULFILLED', 'PAID_DUPLICATE'].includes(payment.status)) return [200, { redirect: `${origin}/?payment=review` }];
    return [202, { message: 'Payment is still being confirmed. Please wait a moment.' }];
  });
}
// Same idea for the GHS 70 KYC-bypass fee. Takes just the reference (like
// reconcileCardPayment) and re-loads fresh state inside the mutation lock,
// rather than being handed a `payment` object from a possibly-stale `load()`
// snapshot: mutating a detached object here would never actually persist,
// which let this run more than once for the same payment (see git history).
async function reconcileKycBypassPayment(reference) {
  const before = load();
  const known = before.kycBypassPayments.find(item => item.paystackReference === reference);
  if (!known) return [404, { error: 'KYC bypass payment was not found.' }];
  let verified = null;
  if (['initialized', 'PAYMENT_INITIALIZED'].includes(known.status) && Date.parse(known.expiresAt) > Date.now()) {
    verified = await hubCall('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }
  return withPurchaseMutation(async () => {
    const db = load();
    const payment = db.kycBypassPayments.find(item => item.paystackReference === reference);
    if (!payment) return [404, { error: 'KYC bypass payment was not found.' }];
    if (Date.parse(payment.expiresAt) <= Date.now() && ['initialized', 'PAYMENT_INITIALIZED'].includes(payment.status)) {
      payment.status = 'expired'; payment.updatedAt = now();
    }
    if (verified && ['initialized', 'PAYMENT_INITIALIZED'].includes(payment.status)) {
      if (Math.round(Number(verified.amount) * 100) !== Math.round(Number(payment.amount) * 100) || verified.currency !== PAYSTACK_CURRENCY) {
        save(db);
        return [409, { error: 'Payment details did not reconcile.' }];
      }
      if (verified.status === 'SUCCESS') completeKycBypassPayment(db, payment, 'hub');
      else if (['FAILED', 'ABANDONED'].includes(verified.status)) {
        payment.status = 'failed'; payment.updatedAt = now();
        const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === payment.userId);
        if (withdrawal && withdrawal.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) withdrawal.paymentStatus = 'failed';
      }
    }
    save(db);
    if (payment.status === 'success') return [200, { redirect: payment.callbackUrl }];
    if (['failed', 'expired'].includes(payment.status)) {
      const origin = payment.callbackUrl ? new URL(payment.callbackUrl).origin : (APP_BASE_URL || '');
      return [200, { redirect: `${origin}/?payment=${payment.status}` }];
    }
    return [202, { message: 'Payment is still being confirmed. Please wait a moment.' }];
  });
}
function approveWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.APPROVED) {
    return {
      withdrawal,
      transaction: db.transactions.find(tx => tx.reference === withdrawal.reference),
      receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference),
    };
  }
  if (withdrawal.status !== WITHDRAWAL_STATUS.PENDING) throw new Error(`Only pending withdrawals can be approved. Current status is ${withdrawal.status}.`);
  const approvedAt = now();
  withdrawal.status = WITHDRAWAL_STATUS.APPROVED;
  withdrawal.approvedAt = approvedAt;
  withdrawal.completedAt = null;
  withdrawal.adminNote = String(adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.APPROVED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.APPROVED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.APPROVED, approvedAt, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  return { withdrawal, transaction: tx, receipt: rcpt };
}
function rejectWithdrawal(db, withdrawal, adminNote = '') {
  normalizeWithdrawalRecord(withdrawal);
  if (withdrawal.status === WITHDRAWAL_STATUS.REJECTED) {
    return {
      withdrawal,
      transaction: db.transactions.find(tx => tx.reference === withdrawal.reference),
      receipt: db.receipts.find(rcpt => rcpt.reference === withdrawal.reference),
    };
  }
  if (![WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION, WITHDRAWAL_STATUS.APPROVED].includes(withdrawal.status)) throw new Error(`Only pending withdrawals can be rejected. Current status is ${withdrawal.status}.`);
  const activeBypassPayment = db.kycBypassPayments.find(payment => payment.withdrawalId === withdrawal.id && ['initialized', 'PAYMENT_INITIALIZED'].includes(payment.status));
  if (activeBypassPayment) throw new Error('This withdrawal has a GHS 70.00 checkout awaiting confirmation and cannot be rejected yet.');
  const user = db.users.find(item => item.id === withdrawal.userId);
  if (!user) throw new Error('Withdrawal user was not found.');
  const rejectedAt = now();
  balance(user, 'redeemed', withdrawal.requestedAmount);
  withdrawal.status = WITHDRAWAL_STATUS.REJECTED;
  withdrawal.rejectedAt = rejectedAt;
  withdrawal.completedAt = null;
  withdrawal.adminNote = String(adminNote || '').trim().slice(0, 500);
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.REJECTED;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.REJECTED, rejectedAt, fundsReturned: true, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.REJECTED;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.REJECTED, rejectedAt, fundsReturned: true, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  return { user, withdrawal, transaction: tx, receipt: rcpt };
}
function markWithdrawalKycReady(db, userId, adminNote = '') {
  const updatedAt = now();
  const withdrawals = db.withdrawals.filter(item => item.userId === userId && item.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION);
  withdrawals.forEach(withdrawal => {
    normalizeWithdrawalRecord(withdrawal);
    withdrawal.status = WITHDRAWAL_STATUS.PENDING;
    withdrawal.kycResolvedAt = updatedAt;
    withdrawal.adminNote = String(adminNote || withdrawal.adminNote || '').trim().slice(0, 500);
    const tx = db.transactions.find(item => item.reference === withdrawal.reference);
    if (tx) {
      tx.status = WITHDRAWAL_STATUS.PENDING;
      tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycResolvedAt: updatedAt };
    }
    const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
    if (rcpt) {
      rcpt.status = WITHDRAWAL_STATUS.PENDING;
      rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycResolvedAt: updatedAt };
    }
  });
  return withdrawals;
}
// The withdrawal is only created (and the balance only deducted) once the KYC fee
// is confirmed as paid. Returns null if the request can no longer be honoured
// (e.g. the user spent their redeemed balance while the checkout was open).
function createWithdrawalFromKycPayment(db, payment) {
  const intent = payment.withdrawalIntent;
  const user = db.users.find(item => item.id === payment.userId);
  if (!intent || !user) return null;
  const method = db.methods.find(item => item.id === intent.methodId && item.userId === user.id);
  if (!method || Number(user.redeemedBalance) < Number(intent.requestedAmount)) return null;
  const ref = uniqueReference(db, 'WDL');
  balance(user, 'redeemed', -intent.requestedAmount);
  const withdrawal = normalizeWithdrawalRecord({ id: uid('wdl'), userId: user.id, methodId: method.id, amount: intent.requestedAmount, requestedAmount: intent.requestedAmount, operationalCharge: intent.operationalCharge, actualAmount: intent.actualAmount, reference: ref, status: WITHDRAWAL_STATUS.PENDING, kycRequired: true, kycBypassUsed: false, kycBypassFee: 0, paymentStatus: 'success', createdAt: now(), approvedAt: null, completedAt: null });
  db.withdrawals.push(withdrawal);
  const related = { withdrawalId: withdrawal.id, methodId: method.id, payoutStatus: WITHDRAWAL_STATUS.PENDING, requestedAmount: intent.requestedAmount, operationalCharge: intent.operationalCharge, actualAmount: intent.actualAmount, kycRequired: true, kycBypassUsed: false };
  transaction(db, { userId: user.id, type: 'debit', amount: intent.requestedAmount, account: 'redeemed', reference: ref, status: WITHDRAWAL_STATUS.PENDING, reason: `Withdrawal to ${method.network}`, related });
  receipt(db, { userId: user.id, type: 'withdrawal', amount: intent.requestedAmount, account: 'redeemed', reference: ref, status: WITHDRAWAL_STATUS.PENDING, related });
  payment.withdrawalId = withdrawal.id;
  payment.withdrawalReference = withdrawal.reference;
  return withdrawal;
}
// Fee was paid but the withdrawal can't be created: verify the user, record the fee
// and refund it in full, and leave the balance untouched.
function completeKycPaymentWithoutWithdrawal(db, payment, provider) {
  payment.status = 'success'; payment.verifiedAt = now(); payment.provider = provider; payment.withdrawalSkipped = true;
  const fee = money(payment.amount);
  const payer = db.users.find(item => item.id === payment.userId);
  if (payer) { payer.kycStatus = KYC_STATUS.VERIFIED; payer.kycVerifiedAt = payer.kycVerifiedAt || now(); payer.kycVerifiedVia = 'bypass'; markWithdrawalKycReady(db, payer.id); }
  transaction(db, { userId: payment.userId, type: 'debit', amount: fee, account: 'external', reference: payment.reference, reason: 'KYC bypass fee', related: { provider } });
  receipt(db, { userId: payment.userId, type: 'kyc_bypass', amount: fee, account: 'external', reference: payment.reference, related: { provider } });
  const refundReference = uniqueReference(db, 'REF');
  const refundedAt = now();
  db.withdrawals.push(normalizeWithdrawalRecord({ id: uid('wdl_refund'), userId: payment.userId, methodId: payment.withdrawalIntent?.methodId || null, amount: fee, requestedAmount: fee, operationalCharge: 0, actualAmount: fee, reference: refundReference, status: 'refunded', isRefund: true, refundType: 'KYC_FEE_REFUND', refundedAt, createdAt: refundedAt }));
  transaction(db, { userId: payment.userId, type: 'credit', entryType: 'REFUND', amount: fee, account: 'external', reference: refundReference, status: 'refunded', reason: 'KYC Fee Refund', related: { originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
  receipt(db, { userId: payment.userId, type: 'kyc_bypass_refund', amount: fee, account: 'external', reference: refundReference, status: 'refunded', related: { originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
  return { withdrawal: null, receipt: db.receipts.find(r => r.reference === payment.reference) };
}
function completeKycBypassPayment(db, payment, provider) {
  let withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === payment.userId);
  if (!withdrawal && payment.status !== 'success' && payment.withdrawalIntent) {
    withdrawal = createWithdrawalFromKycPayment(db, payment);
    if (!withdrawal) return completeKycPaymentWithoutWithdrawal(db, payment, provider);
  }
  if (!withdrawal) {
    if (payment.status === 'success') return { withdrawal: null, receipt: db.receipts.find(r => r.reference === payment.reference) };
    // The withdrawal this checkout belonged to was removed (e.g. legacy pending-KYC clean-up).
    // The fee was still paid: verify the user and refund the fee in full.
    return completeKycPaymentWithoutWithdrawal(db, payment, provider);
  }
  normalizeWithdrawalRecord(withdrawal);
  const fee = money(payment.amount);
  if (payment.status !== 'success') {
    payment.status = 'success';
    payment.verifiedAt = now();
    payment.provider = provider;
    withdrawal.kycBypassUsed = true;
    withdrawal.kycBypassFee = fee;
    withdrawal.paymentStatus = 'success';
    markWithdrawalBypassPaid(db, withdrawal, payment.reference);
    // KYC is a one-time step: after the bypass is paid the user is verified for good and is never asked again.
    const payer = db.users.find(item => item.id === payment.userId);
    if (payer) {
      payer.kycStatus = KYC_STATUS.VERIFIED;
      payer.kycVerifiedAt = payer.kycVerifiedAt || now();
      payer.kycVerifiedVia = 'bypass';
      markWithdrawalKycReady(db, payer.id); // any other withdrawal still waiting on KYC moves on to normal admin review
    }
    // Paid from redeemed balance (admin-approved users) -> the fee is a real ledger debit on that
    // account; paid at checkout -> it is an external payment and never touches the balance.
    const feeAccount = payment.paidWith === 'redeemed_balance' ? 'redeemed' : 'external';
    transaction(db, { userId: payment.userId, type: 'debit', amount: fee, account: feeAccount, reference: payment.reference, reason: feeAccount === 'redeemed' ? 'KYC bypass fee (redeemed balance)' : 'KYC bypass fee', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, provider, paidWith: payment.paidWith || 'checkout' } });
    receipt(db, { userId: payment.userId, type: 'kyc_bypass', amount: fee, account: feeAccount, reference: payment.reference, related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, provider, paidWith: payment.paidWith || 'checkout' } });
    const refundReference = withdrawal.kycBypassRefundReference || uniqueReference(db, 'REF');
    withdrawal.kycBypassRefunded = true;
    withdrawal.kycBypassRefundAmount = fee;
    withdrawal.kycBypassRefundReference = refundReference;
    withdrawal.kycBypassRefundedAt = now();
    const refundedAt = withdrawal.kycBypassRefundedAt;
    // The fee is refunded as a separate payout-history entry. It is an
    // external refund, not a Redeemed Balance credit, so it must never affect
    // the balance ledger.
    db.withdrawals.push(normalizeWithdrawalRecord({
      id: uid('wdl_refund'), userId: payment.userId, methodId: withdrawal.methodId,
      amount: fee, requestedAmount: fee, operationalCharge: 0,
      actualAmount: fee, reference: refundReference, status: 'refunded',
      isRefund: true, refundType: 'KYC_FEE_REFUND',
      refundForWithdrawalId: withdrawal.id, refundForWithdrawalReference: withdrawal.reference,
      refundedAt, createdAt: refundedAt,
    }));
    transaction(db, { userId: payment.userId, type: 'credit', entryType: 'REFUND', amount: fee, account: 'external', reference: refundReference, status: 'refunded', reason: 'KYC Fee Refund', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
    receipt(db, { userId: payment.userId, type: 'kyc_bypass_refund', amount: fee, account: 'external', reference: refundReference, status: 'refunded', related: { withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, originalPaymentReference: payment.reference, refund: true, transactionType: 'REFUND', refundType: 'KYC_FEE_REFUND', provider } });
    const originalTransaction = db.transactions.find(item => item.reference === withdrawal.reference);
    if (originalTransaction) originalTransaction.related = { ...(originalTransaction.related || {}), kycBypassRefunded: true, kycBypassRefundAmount: fee, kycBypassRefundReference: refundReference };
    const originalReceipt = db.receipts.find(item => item.reference === withdrawal.reference);
    if (originalReceipt) originalReceipt.related = { ...(originalReceipt.related || {}), kycBypassRefunded: true, kycBypassRefundAmount: fee, kycBypassRefundReference: refundReference };
  }
  return { withdrawal, receipt: db.receipts.find(r => r.reference === payment.reference) };
}
// Paying the KYC fee never approves a withdrawal. The withdrawal stays PENDING and
// only moves on when an admin approves it from the console.
function markWithdrawalBypassPaid(db, withdrawal, paymentReference) {
  withdrawal.status = WITHDRAWAL_STATUS.PENDING;
  withdrawal.approvedAt = null;
  withdrawal.completedAt = null;
  const tx = db.transactions.find(item => item.reference === withdrawal.reference);
  if (tx) {
    tx.status = WITHDRAWAL_STATUS.PENDING;
    tx.related = { ...(tx.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycBypassUsed: true, kycBypassPaymentReference: paymentReference, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
  const rcpt = db.receipts.find(item => item.reference === withdrawal.reference);
  if (rcpt) {
    rcpt.status = WITHDRAWAL_STATUS.PENDING;
    rcpt.related = { ...(rcpt.related || {}), payoutStatus: WITHDRAWAL_STATUS.PENDING, kycBypassUsed: true, kycBypassPaymentReference: paymentReference, actualAmount: withdrawal.actualAmount, operationalCharge: withdrawal.operationalCharge };
  }
}
function adminAuthorized(req) {
  if (!ADMIN_APPROVAL_TOKEN) return false;
  const header = String(req.headers['x-admin-token'] || '');
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const submitted = header || auth;
  return submitted.length === ADMIN_APPROVAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(ADMIN_APPROVAL_TOKEN));
}
function adminCredentialsConfigured() { return Boolean(ADMIN_EMAIL && (ADMIN_PASSWORD || ADMIN_PASSWORD_HASH)); }
function adminSessionCookie(token, req, maxAge = ADMIN_SESSION_MAX_AGE / 1000) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function clearAdminSessionCookie(req) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return `phantom_admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
function adminSessionFor(req, db) {
  const token = cookie(req).phantom_admin_session;
  return db.adminSessions.find(session => session.token === token && session.expiresAt > Date.now());
}
function adminIdentity(req, db) {
  const session = adminSessionFor(req, db);
  if (session) return { id: session.id, email: session.email, role: session.role || 'owner', auth: 'session' };
  if (adminAuthorized(req)) return { id: 'env-admin', email: ADMIN_EMAIL || 'token-admin', role: 'owner', auth: 'token' };
  return null;
}
function requireAdmin(req, res, db) {
  const admin = adminIdentity(req, db);
  if (!admin) { fail(res, 401, 'Admin authentication is required.'); return null; }
  return admin;
}
function adminAudit(db, { admin, action, targetType, targetId, before = null, after = null, reason = '' }) {
  db.adminAuditLogs.push({
    id: uid('audit'),
    adminId: admin?.id || 'unknown',
    adminEmail: admin?.email || 'unknown',
    action,
    targetType,
    targetId,
    before,
    after,
    reason: String(reason || '').trim().slice(0, 500),
    createdAt: now(),
  });
}
function adminSafeUser(user, db) {
  if (!user) return null;
  const purchases = db.purchases.filter(item => item.userId === user.id);
  const redemptions = db.codes.filter(item => item.userId === user.id && item.status === 'redeemed');
  const withdrawals = db.withdrawals.filter(item => item.userId === user.id && !item.isRefund);
  return {
    id: user.id,
    name: user.name,
    email: user.email || '',
    phone: user.phone || '',
    walletBalance: user.walletBalance,
    redeemedBalance: user.redeemedBalance,
    createdAt: user.createdAt,
    kycStatus: user.kycStatus || KYC_STATUS.NOT_VERIFIED,
    kycVerifiedAt: user.kycVerifiedAt || null,
    kycSubmittedAt: user.kycSubmittedAt || null,
    canBuyWithBalance: Boolean(user.canBuyWithBalance),
    blocked: Boolean(user.blocked),
    blockedAt: user.blockedAt || null,
    blockedReason: user.blockedReason || null,
    hasPin: Boolean(user.pinHash),
    purchaseCount: purchases.length,
    redemptionCount: redemptions.length,
    withdrawalCount: withdrawals.length,
    sessionCount: db.sessions.filter(session => session.userId === user.id && session.expiresAt > Date.now()).length,
  };
}
function adminSafeCode(code, card, user) {
  return {
    id: code.id,
    status: code.status,
    cardId: code.cardId,
    cardTitle: card?.title || 'Unknown card',
    userId: code.userId,
    userName: user?.name || 'Unknown user',
    purchaseId: code.purchaseId,
    orderId: code.orderId,
    purchaseAmount: code.purchaseAmount ?? null,
    rewardAmount: code.rewardAmount ?? code.amount ?? null,
    rewardMultiplier: code.rewardMultiplier ?? null,
    createdAt: code.createdAt,
    redeemedAt: code.redeemedAt || null,
    redemptionReference: code.redemptionReference || null,
  };
}
function adminPage(items, url, searchFields = [], statusField = 'status') {
  const query = url.searchParams;
  const search = String(query.get('search') || '').trim().toLowerCase();
  const status = String(query.get('status') || '').trim();
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') || 25)));
  const page = Math.max(1, Number(query.get('page') || 1));
  let filtered = items;
  if (search) filtered = filtered.filter(item => searchFields.some(field => String(field(item) ?? '').toLowerCase().includes(search)));
  if (status && status !== 'all') filtered = filtered.filter(item => String(item[statusField] || '') === status);
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  return { items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize), total, page: safePage, pageSize, pages };
}
function adminStatusCounts(items) {
  return items.reduce((result, item) => { const key = String(item.status || 'unknown'); result[key] = (result[key] || 0) + 1; return result; }, {});
}
function adminDayKey(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}
function adminTrend(db, days = 14) {
  const result = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.now() - (days - index - 1) * 86400000);
    return { date: date.toISOString().slice(0, 10), users: 0, spent: 0 };
  });
  const byDate = new Map(result.map(item => [item.date, item]));
  const windowStart = result[0].date;
  // Users: a running (cumulative) count of registered accounts through each day.
  const baselineUsers = db.users.filter(item => adminDayKey(item.createdAt) < windowStart).length;
  const newUsersByDay = new Map();
  db.users.forEach(item => { const key = adminDayKey(item.createdAt); if (byDate.has(key)) newUsersByDay.set(key, (newUsersByDay.get(key) || 0) + 1); });
  let runningUsers = baselineUsers;
  result.forEach(row => { runningUsers += newUsersByDay.get(row.date) || 0; row.users = runningUsers; });
  // Spent: money users paid that day, combining card purchases and KYC verification (bypass) fees.
  db.purchases.forEach(item => { const row = byDate.get(adminDayKey(item.createdAt)); if (row) row.spent += Number(item.amountPaid ?? item.amount ?? 0); });
  (db.kycBypassPayments || []).filter(item => String(item.status).toLowerCase() === 'success').forEach(item => { const row = byDate.get(adminDayKey(item.verifiedAt || item.updatedAt || item.createdAt)); if (row) row.spent += Number(item.amount || 0); });
  return result;
}
function adminPurchaseRow(db, purchase) {
  const user = db.users.find(item => item.id === purchase.userId);
  const card = db.cards.find(item => item.id === purchase.cardId);
  const code = db.codes.find(item => item.purchaseId === purchase.id);
  const transactionItem = db.transactions.find(item => item.reference === purchase.reference);
  return {
    ...purchase,
    idempotencyKey: undefined,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    cardTitle: card?.title || 'Unknown card',
    cardCategory: card?.category || '',
    codeStatus: code?.status || 'missing',
    redemptionReference: code?.redemptionReference || null,
    transactionStatus: transactionItem?.status || null,
  };
}
function adminDepositRow(db, deposit) {
  const user = db.users.find(item => item.id === deposit.userId);
  const transactionItem = db.transactions.find(item => item.reference === deposit.reference);
  return {
    ...deposit,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    ledgerStatus: transactionItem?.status || null,
    receiptExists: db.receipts.some(item => item.reference === deposit.reference),
  };
}
function adminWithdrawalRow(db, withdrawal) {
  const user = db.users.find(item => item.id === withdrawal.userId);
  const method = db.methods.find(item => item.id === withdrawal.methodId);
  const transactionItem = db.transactions.find(item => item.reference === withdrawal.reference);
  return {
    ...withdrawal,
    userName: user?.name || 'Unknown user',
    userEmail: user?.email || '',
    userKycStatus: user?.kycStatus || KYC_STATUS.NOT_VERIFIED,
    method: method ? { id: method.id, network: method.network, accountName: method.accountName, phone: method.phone } : null,
    transactionStatus: transactionItem?.status || null,
  };
}
function adminTransactionRow(db, transactionItem) {
  const user = db.users.find(item => item.id === transactionItem.userId);
  const related = { ...(transactionItem.related || {}) };
  delete related.code;
  return { ...transactionItem, related, userName: user?.name || 'Unknown user', userEmail: user?.email || '' };
}
function kycBypassCallback(req, referenceValue, browserOrigin = '') {
  const browser = normalizeOrigin(browserOrigin);
  const origin = browser || requestOrigin(req);
  return `${origin}/?kyc_bypass_reference=${encodeURIComponent(referenceValue)}`;
}
// Same idea for a wallet top-up: where to send the browser once we've reconciled the
// payment ourselves. Computed and stored at initiate time (not at /complete time),
// since by the time /complete runs the request is same-origin to Phantom Cards itself.
function cardPaymentCallbackUrl(req, transactionId, browserOrigin = '') {
  const browser = normalizeOrigin(browserOrigin);
  const origin = browser || requestOrigin(req);
  return `${origin}/?card_payment=1&transactionId=${encodeURIComponent(transactionId)}`;
}
function requireUser(req, res, db) {
  const user = userFor(req, db);
  if (!user) { fail(res, 401, 'Please sign in.'); return null; }
  if (user.blocked) { fail(res, 403, 'Your account has been blocked. Contact support for help.'); return null; }
  return user;
}
function staticFile(req, res, file) { const safe = path.normalize(file).replace(/^\.\.([/\\]|$)/, ''); const target = path.join(ROOT, safe === '/' ? 'index.html' : safe); if (!target.startsWith(ROOT) || !fs.existsSync(target)) return false; const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }; const contentType = types[path.extname(target)] || 'application/octet-stream'; if (path.extname(target) === '.html') { const origin = requestOrigin(req); const html = fs.readFileSync(target, 'utf8').split('__ORIGIN__').join(origin); res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store, max-age=0' }); res.end(html); return true; } res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store, max-age=0' }); fs.createReadStream(target).pipe(res); return true; }
function appBaseUrlPortMismatch() {
  try {
    const parsed = new URL(APP_BASE_URL);
    if (!isLocalHost(parsed.hostname)) return false;
    return Number(parsed.port || 80) !== PORT;
  } catch {
    return false;
  }
}
let purchaseMutationQueue = Promise.resolve();
function withPurchaseMutation(task) {
  const previous = purchaseMutationQueue;
  let release;
  purchaseMutationQueue = new Promise(resolve => { release = resolve; });
  return previous.catch(() => {}).then(async () => {
    try { return await task(); } finally { release(); }
  });
}
async function handlePurchaseRequest(req, res) {
  const p = await body(req);
  // Stage 1 (serialized): validate, hold one unit of stock, and record the payment session.
  const staged = await withPurchaseMutation(async () => {
    const db = load();
    const user = requireUser(req, res, db);
    if (!user) return { done: true };
    if (!HUB_BASE_URL || !HUB_API_KEY || !HUB_API_SECRET) { fail(res, 503, 'Card payments are not configured.'); return { done: true }; }
    sweepCardPayments(db);
    const idempotencyKey = String(p.idempotencyKey || '');
    if (!/^[A-Za-z0-9_-]{16,160}$/.test(idempotencyKey)) { fail(res, 400, 'Purchase request is missing a valid idempotency key.'); return { done: true }; }

    const existing = db.purchases.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.cardId !== p.cardId) { fail(res, 409, 'This purchase key belongs to a different card.'); return { done: true }; }
      const existingReceipt = db.receipts.find(item => item.reference === existing.reference);
      json(res, 200, { duplicate: true, state: publicState(db, user), purchase: publicPurchase(existing), receipt: existingReceipt && publicReceipt(existingReceipt) });
      return { done: true };
    }
    const open = db.cardPayments.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey && cardPaymentIsActive(item));
    if (open) {
      if (open.cardId !== p.cardId) { fail(res, 409, 'This purchase key belongs to a different card.'); return { done: true }; }
      if (!open.authorizationUrl) { fail(res, 409, 'Your payment is being prepared. Try again in a moment.'); return { done: true }; }
      json(res, 200, { duplicate: true, payment: publicCardPayment(open) });
      return { done: true };
    }

    const card = db.cards.find(c => c.id === p.cardId && c.active);
    if (!card || card.stock < 1 || card.isFreeGift) { fail(res, 404, 'This card is unavailable.'); return { done: true }; }
    const purchaseDate = ghanaCalendarDate();
    const priceKey = purchasePriceKey(card);
    if (tierLimitReached(db, user.id, priceKey)) { fail(res, 409, 'This price tier is no longer available on your account.'); return { done: true }; }
    const dailyRecord = db.dailyPurchaseCounts.find(item => item.userId === user.id && item.purchaseDate === purchaseDate);
    const purchasedToday = Number(dailyRecord?.count || 0);
    const pendingToday = db.cardPayments.filter(item => item.userId === user.id && item.purchaseDate === purchaseDate && cardPaymentIsActive(item)).length;
    if (purchasedToday >= DAILY_CARD_PURCHASE_LIMIT) {
      fail(res, 409, `Your daily purchase limit of ${DAILY_CARD_PURCHASE_LIMIT} cards has been reached for today. It resets at midnight Ghana time.`);
      return { done: true };
    }
    if (purchasedToday + pendingToday >= DAILY_CARD_PURCHASE_LIMIT) {
      fail(res, 409, `You already have unfinished payments counting toward today's ${DAILY_CARD_PURCHASE_LIMIT}-card daily limit. Finish them, or wait up to ${Math.round(PAYMENT_SESSION_MS / 60000)} minutes for them to expire, then try again.`);
      return { done: true };
    }

    const createdAt = now();
    const amount = money(card.priceGhs);
    const transactionId = uniqueReference(db, 'CARD');
    const payment = {
      id: uid('cpay'), transactionId, reference: uniqueReference(db, 'CPAY'), userId: user.id, cardId: card.id, idempotencyKey,
      amount, amountMinor: Math.round(amount * 100), currency: PAYSTACK_CURRENCY, purpose: 'CARD_PURCHASE', paymentProvider: 'hub',
      status: 'PENDING', priceKey, purchaseDate, stockReserved: true, purchaseId: null,
      expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), callbackUrl: cardPaymentCallbackUrl(req, transactionId, p.returnOrigin), createdAt, updatedAt: createdAt,
    };
    card.stock--; card.active = card.stock > 0;
    db.cardPayments.push(payment);
    save(db);
    return { payment, email: paystackEmailForUser(user), userId: user.id, redirectUrl: `${hubReturnOrigin(req, p.returnOrigin)}/api/payment/return` };
  });
  if (staged.done) return;

  // Stage 2 (outside the queue so a slow hub never blocks other buyers): open the checkout.
  const { payment } = staged;
  try {
    const result = await hubCall('POST', '/transaction/initialize', {
      email: staged.email, amount: payment.amount, currency: payment.currency, redirectUrl: staged.redirectUrl,
      metadata: { site: 'PHANTOM_CARDS', transactionId: payment.transactionId, userId: staged.userId, purpose: 'CARD_PURCHASE', cardId: payment.cardId },
    });
    await withPurchaseMutation(async () => {
      const db = load();
      const stored = db.cardPayments.find(item => item.id === payment.id);
      if (stored && stored.status === 'PENDING') {
        stored.status = 'PAYMENT_INITIALIZED'; stored.paystackReference = result.reference; stored.authorizationUrl = result.checkoutUrl; stored.updatedAt = now();
        save(db);
      }
    });
    return json(res, 201, { payment: publicCardPayment({ ...payment, status: 'PAYMENT_INITIALIZED', authorizationUrl: result.checkoutUrl }) });
  } catch (error) {
    await withPurchaseMutation(async () => {
      const db = load();
      const stored = db.cardPayments.find(item => item.id === payment.id);
      if (stored && stored.status === 'PENDING') { stored.status = 'FAILED'; stored.updatedAt = now(); releaseCardReservation(db, stored); save(db); }
    });
    return fail(res, 502, `Payment initialization failed: ${error.message}`);
  }
}
// Buying with redeemed balance. Only users an admin has switched on (user.canBuyWithBalance)
// may do this; everyone else must pay through the checkout. It runs entirely inside the
// serialized purchase queue so stock, the daily limit and the balance cannot race.
async function handleBalancePurchaseRequest(req, res) {
  const p = await body(req);
  return withPurchaseMutation(async () => {
    const db = load();
    const user = requireUser(req, res, db);
    if (!user) return;
    if (!user.canBuyWithBalance) return fail(res, 403, 'Paying with your balance is not enabled for your account.');
    const idempotencyKey = String(p.idempotencyKey || '');
    if (!/^[A-Za-z0-9_-]{16,160}$/.test(idempotencyKey)) return fail(res, 400, 'Purchase request is missing a valid idempotency key.');
    const existing = db.purchases.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.cardId !== p.cardId) return fail(res, 409, 'This purchase key belongs to a different card.');
      const existingReceipt = db.receipts.find(item => item.reference === existing.reference);
      return json(res, 200, { duplicate: true, state: publicState(db, user), purchase: publicPurchase(existing), receipt: existingReceipt && publicReceipt(existingReceipt) });
    }
    sweepCardPayments(db);
    const card = db.cards.find(c => c.id === p.cardId && c.active);
    if (!card || card.stock < 1 || card.isFreeGift) return fail(res, 404, 'This card is unavailable.');
    const purchaseDate = ghanaCalendarDate();
    if (tierLimitReached(db, user.id, purchasePriceKey(card))) return fail(res, 409, 'This price tier is no longer available on your account.');
    const dailyRecord = db.dailyPurchaseCounts.find(item => item.userId === user.id && item.purchaseDate === purchaseDate);
    const purchasedToday = Number(dailyRecord?.count || 0);
    const pendingToday = db.cardPayments.filter(item => item.userId === user.id && item.purchaseDate === purchaseDate && cardPaymentIsActive(item)).length;
    if (purchasedToday + pendingToday >= DAILY_CARD_PURCHASE_LIMIT) return fail(res, 409, `Your daily purchase limit of ${DAILY_CARD_PURCHASE_LIMIT} cards has been reached for today. It resets at midnight Ghana time.`);
    const amount = money(card.priceGhs);
    if (money(user.redeemedBalance) < amount) return fail(res, 402, `Your redeemed balance is GHS ${money(user.redeemedBalance).toFixed(2)}, which is not enough for this GHS ${amount.toFixed(2)} card. Redeem more cards or pay with the secure checkout instead.`);

    const orderId = uniqueReference(db, 'ORD');
    const purchaseReference = uniqueReference(db, 'PUR');
    const code = uniqueCode(db);
    const reward = rewardAllocationForPrice(amount);
    const createdAt = now();
    card.stock--; card.active = card.stock > 0;
    balance(user, 'redeemed', -amount);
    const purchase = { id: uid('order'), orderId, reference: purchaseReference, userId: user.id, cardId: card.id, idempotencyKey, amount, amountPaid: amount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, paymentReference: null, paidWith: 'redeemed_balance', status: 'sealed', createdAt };
    db.purchases.push(purchase);
    if (dailyRecord) dailyRecord.count = Number(dailyRecord.count || 0) + 1;
    else db.dailyPurchaseCounts.push({ id: uid('daily'), userId: user.id, purchaseDate, count: 1 });
    db.codes.push({ id: uid('code'), code, userId: user.id, cardId: card.id, orderId, purchaseId: purchase.id, amount: reward.rewardAmount, purchaseAmount: amount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, status: 'unused', createdAt, redeemedAt: null, redemptionReference: null });
    const related = { cardId: card.id, orderId, code, purchaseAmount: amount, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, provider: 'redeemed_balance', paidWith: 'redeemed_balance' };
    transaction(db, { userId: user.id, type: 'debit', amount, account: 'redeemed', reference: purchaseReference, reason: 'Card purchase (redeemed balance)', related });
    const rcpt = receipt(db, { userId: user.id, type: 'purchase', amount, account: 'redeemed', reference: purchaseReference, related });
    save(db);
    console.log('[purchase:balance]', orderId, { amount, purchaseDate });
    return json(res, 201, { state: publicState(db, user), purchase: publicPurchase(purchase), receipt: rcpt && publicReceipt(rcpt) });
  });
}
// Free gifts skip the payment hub entirely: no charge, no card payment session.
// Each user may claim a given gift card exactly once, tracked by looking for an
// existing purchase of that card by that user with isFreeGift set.
async function handleClaimGiftRequest(req, res) {
  const p = await body(req);
  await withPurchaseMutation(async () => {
    const db = load();
    const user = requireUser(req, res, db);
    if (!user) return;
    const card = db.cards.find(item => item.id === p.cardId && item.isFreeGift);
    if (!card) { fail(res, 404, 'This free gift is not available.'); return; }
    const alreadyClaimed = db.purchases.some(item => item.userId === user.id && item.cardId === card.id && item.isFreeGift);
    if (alreadyClaimed) { fail(res, 409, 'You have already claimed this free gift.'); return; }
    const createdAt = now();
    const orderId = uniqueReference(db, 'ORD');
    const purchaseReference = uniqueReference(db, 'GIFT');
    const code = uniqueCode(db);
    const reward = rewardAllocationForPrice(card.giftBaseValueGhs || 0);
    const purchase = {
      id: uid('order'), orderId, reference: purchaseReference, userId: user.id, cardId: card.id,
      idempotencyKey: `gift_${user.id}_${card.id}`, amount: 0, amountPaid: 0,
      rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier,
      paymentReference: null, isFreeGift: true, status: 'sealed', createdAt,
    };
    db.purchases.push(purchase);
    db.codes.push({
      id: uid('code'), code, userId: user.id, cardId: card.id, orderId, purchaseId: purchase.id,
      amount: reward.rewardAmount, purchaseAmount: 0, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier,
      status: 'unused', createdAt, redeemedAt: null, redemptionReference: null,
    });
    const related = { cardId: card.id, orderId, code, purchaseAmount: 0, rewardAmount: reward.rewardAmount, rewardMultiplier: reward.rewardMultiplier, provider: 'free_gift', isFreeGift: true };
    receipt(db, { userId: user.id, type: 'purchase', amount: 0, account: 'external', reference: purchaseReference, related });
    save(db);
    json(res, 201, { state: publicState(db, user), purchase: publicPurchase(purchase) });
  });
}
async function route(req, res) {
  const url = new URL(req.url, appBaseUrlForRoute(req)); const { pathname } = url;
  // Everything below, including the initial load(), is inside this try/catch: a single
  // bad request (or a storage hiccup) must fail that one request, never take the whole
  // process down and force Railway into a restart loop.
  try {
    let db = load();
    if (hasExpiredCardPayments(db)) { await withPurchaseMutation(async () => { sweepCardPayments(load()); }); db = load(); }
    if (!pathname.startsWith('/api/')) {
      if (pathname === '/admin' || pathname === '/admin/') return staticFile(req, res, '/admin.html') || fail(res, 404, 'Not found');
      return staticFile(req, res, decodeURIComponent(pathname)) || fail(res, 404, 'Not found');
    }
    if (!originAllowed(req)) return fail(res, 403, 'Request origin is not allowed.');
    if (rateLimit(req, res, pathname)) return;
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, hubConfigured: Boolean(HUB_BASE_URL && HUB_API_KEY && HUB_API_SECRET), appBaseUrl: APP_BASE_URL || requestOrigin(req), appBaseUrlConfigured: Boolean(APP_BASE_URL), dataFileConfigured: Boolean(process.env.PHANTOM_DATA_FILE), dataFile: DATA_FILE });
    if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { minWithdrawal: MIN_WITHDRAWAL, minPurchasedCardsForWithdrawal: withdrawalCardRequirement(db), operationalChargeRate: OPERATIONAL_CHARGE_RATE, kycBypassFee: KYC_BYPASS_FEE, rewardMultiplierMin: REWARD_MULTIPLIER_MIN, rewardMultiplierMax: REWARD_MULTIPLIER_MAX, appBaseUrl: APP_BASE_URL || requestOrigin(req) });
    // The browser lands here after Paystack checkout, via the hub's own redirectUrl.
    // We never trust the hub's ?status= query param blindly — we re-verify the payment
    // with the hub server-side right here, then send a single HTTP redirect straight
    // back into the app with no visible interstitial page in between.
    if (req.method === 'GET' && pathname === '/api/payment/return') {
      const reference = String(url.searchParams.get('reference') || '');
      const origin = APP_BASE_URL || requestOrigin(req);
      if (!/^[A-Za-z0-9_-]{4,160}$/.test(reference)) {
        res.writeHead(302, { location: `${origin}/?payment=error`, 'cache-control': 'no-store' });
        return res.end();
      }
      const cardPayment = db.cardPayments.find(x => x.paystackReference === reference);
      const kycPayment = !cardPayment && db.kycBypassPayments.find(x => x.paystackReference === reference);
      // Fallback if the hub hasn't confirmed yet (rare — reconcile below normally
      // resolves synchronously): send the browser to the same URL the app already
      // knows how to poll and show a "still confirming" state for, instead of a
      // generic message that would wrongly imply the payment failed.
      let destination = cardPayment ? cardPayment.callbackUrl : (kycPayment ? kycPayment.callbackUrl : `${origin}/?payment=error`);
      try {
        if (cardPayment || kycPayment) {
          const [, result] = cardPayment
            ? await reconcileCardPayment(reference)
            : await reconcileKycBypassPayment(reference);
          if (result && result.redirect) destination = result.redirect;
        }
      } catch (error) {
        console.error('[payment:return:error]', reference, error.message || error);
        destination = `${origin}/?payment=error`;
      }
      res.writeHead(302, { location: destination, 'cache-control': 'no-store' });
      return res.end();
    }
    // Called by the confirmation page above (no session — the browser may have bounced
    // through the hub and Paystack in between). Reconciles directly against the hub's
    // own /transaction/verify, then tells the browser where to go next.
    if (req.method === 'POST' && /^\/api\/payments\/[^/]+\/complete$/.test(pathname)) {
      const reference = decodeURIComponent(pathname.split('/')[3]);
      const cardPayment = db.cardPayments.find(x => x.paystackReference === reference);
      const payment = !cardPayment && db.kycBypassPayments.find(x => x.paystackReference === reference);
      if (!cardPayment && !payment) return fail(res, 404, 'Payment session was not found.');
      try {
        if (cardPayment) return json(res, ...(await reconcileCardPayment(reference)));
        return json(res, ...(await reconcileKycBypassPayment(reference)));
      } catch (error) { return fail(res, 502, error.message || 'Payment verification failed.'); }
    }
    // The hub POSTs here the moment Paystack confirms (or fails) a charge — this is the
    // sole wallet-credit path that does not depend on the customer's browser returning.
    if (req.method === 'POST' && pathname === '/api/webhooks/hub') {
      const raw = await rawBody(req);
      if (!verifyHubWebhookSignature(raw, req.headers['x-hub-signature'])) return fail(res, 401, 'Invalid hub signature.');
      let event; try { event = JSON.parse(raw.toString() || '{}'); } catch { return fail(res, 400, 'Malformed webhook payload.'); }
      if (event.event !== 'transaction.completed') return json(res, 200, { ok: true, ignored: true });
      const reference = String(event.reference || '');
      const status = event.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
      if (db.cardPayments.some(x => x.paystackReference === reference)) {
        return withPurchaseMutation(async () => {
          const fresh = load();
          const cardPayment = fresh.cardPayments.find(x => x.paystackReference === reference);
          const matches = Math.round(Number(event.amount) * 100) === cardPayment.amountMinor && String(event.currency) === cardPayment.currency
            && event.metadata?.purpose === 'CARD_PURCHASE' && event.metadata?.transactionId === cardPayment.transactionId;
          if (!matches) { console.error('[hub:webhook] card payment event did not reconcile', reference); return json(res, 200, { ok: true, mismatched: true }); }
          if (status === 'SUCCESS') completeCardPayment(fresh, cardPayment, 'hub');
          else if (CARD_PAYMENT_ACTIVE.includes(cardPayment.status)) { cardPayment.status = 'FAILED'; cardPayment.updatedAt = now(); releaseCardReservation(fresh, cardPayment); }
          save(fresh);
          return json(res, 200, { ok: true });
        });
      }
      if (!db.kycBypassPayments.some(x => x.paystackReference === reference)) return json(res, 200, { ok: true, unmatched: true });
      return withPurchaseMutation(async () => {
        const fresh = load();
        const payment = fresh.kycBypassPayments.find(x => x.paystackReference === reference);
        if (!payment) return json(res, 200, { ok: true, unmatched: true });
        const matches = Math.round(Number(event.amount) * 100) === Math.round(Number(payment.amount) * 100) && String(event.currency) === PAYSTACK_CURRENCY
          && event.metadata?.purpose === 'KYC_BYPASS' && event.metadata?.transactionId === payment.reference;
        if (!matches) { console.error('[hub:webhook] KYC bypass event did not reconcile', reference); return json(res, 200, { ok: true, mismatched: true }); }
        if (status === 'SUCCESS') completeKycBypassPayment(fresh, payment, 'hub');
        else if (payment.status !== 'success') {
          payment.status = 'failed'; payment.updatedAt = now();
          const withdrawal = fresh.withdrawals.find(item => item.id === payment.withdrawalId && item.userId === payment.userId);
          if (withdrawal && withdrawal.status === WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) withdrawal.paymentStatus = 'failed';
        }
        save(fresh);
        return json(res, 200, { ok: true });
      });
    }
    if (req.method === 'POST' && pathname === '/api/admin/auth/login') {
      if (!adminCredentialsConfigured()) return fail(res, 503, 'Admin credentials are not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD).');
      const p = await body(req);
      const email = normalizeEmail(p.email);
      const password = String(p.password || '');
      let valid = email === ADMIN_EMAIL;
      if (valid && ADMIN_PASSWORD_HASH) valid = await passwordMatches(password, ADMIN_PASSWORD_HASH);
      else if (valid) valid = safeEqual(password, ADMIN_PASSWORD);
      if (!valid) return fail(res, 401, 'Incorrect admin email or password.');
      const token = crypto.randomBytes(32).toString('hex');
      db.adminSessions = db.adminSessions.filter(session => session.expiresAt > Date.now());
      db.adminSessions.push({ id: uid('admin'), token, email: ADMIN_EMAIL, role: 'owner', createdAt: now(), expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE });
      save(db);
      return json(res, 200, { ok: true, admin: { email: ADMIN_EMAIL, role: 'owner' } }, { 'set-cookie': adminSessionCookie(token, req) });
    }
    if (req.method === 'POST' && pathname === '/api/admin/auth/logout') {
      const token = cookie(req).phantom_admin_session;
      db.adminSessions = db.adminSessions.filter(session => session.token !== token);
      save(db);
      return json(res, 200, { ok: true }, { 'set-cookie': clearAdminSessionCookie(req) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/auth/session') {
      const admin = adminIdentity(req, db);
      if (!admin) return fail(res, 401, 'Admin authentication is required.');
      return json(res, 200, { ok: true, admin: { email: admin.email, role: admin.role, auth: admin.auth } });
    }
    if (req.method === 'GET' && pathname === '/api/admin/summary') {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const pendingWithdrawals = db.withdrawals.filter(item => !item.isRefund && [WITHDRAWAL_STATUS.PENDING, WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION].includes(item.status));
      const pendingKyc = db.users.filter(item => item.kycStatus === KYC_STATUS.PENDING);
      const pendingDeposits = db.deposits.filter(item => ['PENDING', 'PAYMENT_INITIALIZED', 'initialized'].includes(item.status));
      const pendingBypass = db.kycBypassPayments.filter(item => ['initialized', 'PAYMENT_INITIALIZED', 'PENDING'].includes(item.status));
      const pendingCardPayments = db.cardPayments.filter(cardPaymentIsActive);
      const paymentsNeedingReview = db.cardPayments.filter(item => ['PAID_UNFULFILLED', 'PAID_DUPLICATE'].includes(item.status));
      const recent = (items, mapper) => items.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 6).map(mapper);
      return json(res, 200, {
        admin: { email: admin.email, role: admin.role },
        metrics: {
          users: db.users.length,
          activeCards: db.cards.filter(item => item.active).length,
          stockUnits: db.cards.reduce((sum, item) => sum + Number(item.stock || 0), 0),
          deposits: db.deposits.length,
          purchases: db.purchases.length,
          redemptions: db.codes.filter(item => item.status === 'redeemed').length,
          pendingWithdrawals: pendingWithdrawals.length,
          pendingKyc: pendingKyc.length,
          pendingPayments: pendingDeposits.length + pendingBypass.length + pendingCardPayments.length,
          paymentsNeedingReview: paymentsNeedingReview.length,
          walletDepositVolume: money(db.transactions.filter(item => item.account === 'wallet' && item.type === 'credit').reduce((sum, item) => sum + Number(item.amount || 0), 0)),
          purchaseVolume: money(db.purchases.reduce((sum, item) => sum + Number(item.amountPaid ?? item.amount ?? 0), 0)),
          redemptionVolume: money(db.transactions.filter(item => item.account === 'redeemed' && item.type === 'credit').reduce((sum, item) => sum + Number(item.amount || 0), 0)),
          withdrawalVolume: money(db.withdrawals.filter(item => !item.isRefund).reduce((sum, item) => sum + Number(item.requestedAmount ?? item.amount ?? 0), 0)),
        },
        statuses: { deposits: adminStatusCounts(db.deposits), withdrawals: adminStatusCounts(db.withdrawals.filter(item => !item.isRefund)), kyc: adminStatusCounts(db.users.map(item => ({ status: item.kycStatus || KYC_STATUS.NOT_VERIFIED }))) },
        attention: {
          withdrawals: pendingWithdrawals.slice(0, 8).map(item => adminWithdrawalRow(db, item)),
          kyc: pendingKyc.slice(0, 8).map(item => adminSafeUser(item, db)),
          payments: pendingDeposits.slice(0, 8).map(item => adminDepositRow(db, item)),
        },
        recent: {
          transactions: recent(db.transactions, item => adminTransactionRow(db, item)),
          withdrawals: recent(db.withdrawals.filter(item => !item.isRefund), item => adminWithdrawalRow(db, item)),
        },
        trend: adminTrend(db),
        settings: { minWithdrawal: MIN_WITHDRAWAL, minPurchasedCardsForWithdrawal: withdrawalCardRequirement(db), maxWithdrawalCardRequirement: MAX_WITHDRAWAL_CARD_REQUIREMENT, limits: SETTING_LIMITS, dailyPurchaseLimit: DAILY_CARD_PURCHASE_LIMIT, tierPurchaseLimit: TIER_PURCHASE_LIMIT, operationalChargeRate: OPERATIONAL_CHARGE_RATE, kycBypassFee: KYC_BYPASS_FEE, rewardMultiplierMin: REWARD_MULTIPLIER_MIN, rewardMultiplierMax: REWARD_MULTIPLIER_MAX, hubConfigured: Boolean(HUB_BASE_URL && HUB_API_KEY && HUB_API_SECRET) },
      });
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      if (!requireAdmin(req, res, db)) return;
      const page = adminPage(db.users.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), url, [item => item.name, item => item.email, item => item.phone, item => item.id], 'kycStatus');
      return json(res, 200, { ...page, items: page.items.map(item => adminSafeUser(item, db)) });
    }
    if (req.method === 'GET' && /^\/api\/admin\/users\/[^/]+\/kyc\/documents\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const parts = pathname.split('/').map(decodeURIComponent); const userId = parts[4]; const storageKey = parts[7];
      const target = db.users.find(item => item.id === userId); const document = target?.kycSubmission?.documents?.find(item => item.storageKey === storageKey);
      if (!target || !document || !/^[A-Za-z0-9_-]+\.bin$/.test(storageKey)) return fail(res, 404, 'KYC document was not found.');
      const targetFile = path.join(KYC_DOCUMENTS_DIR, target.id, storageKey);
      if (!targetFile.startsWith(path.join(KYC_DOCUMENTS_DIR, target.id)) || !fs.existsSync(targetFile)) return fail(res, 404, 'KYC document was not found.');
      res.writeHead(200, { 'content-type': document.type || 'application/octet-stream', 'content-length': String(fs.statSync(targetFile).size), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(targetFile).pipe(res);
    }
    if (req.method === 'GET' && /^\/api\/admin\/users\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId);
      if (!target) return fail(res, 404, 'User was not found.');
      const cardMap = new Map(db.cards.map(item => [item.id, item]));
      return json(res, 200, { user: adminSafeUser(target, db), kycSubmission: target.kycSubmission || null, methods: db.methods.filter(item => item.userId === userId), purchases: db.purchases.filter(item => item.userId === userId).map(item => adminPurchaseRow(db, item)), codes: db.codes.filter(item => item.userId === userId).map(item => adminSafeCode(item, cardMap.get(item.cardId), target)), deposits: db.deposits.filter(item => item.userId === userId).map(item => adminDepositRow(db, item)), withdrawals: db.withdrawals.filter(item => item.userId === userId).map(item => adminWithdrawalRow(db, item)), transactions: db.transactions.filter(item => item.userId === userId).map(item => adminTransactionRow(db, item)).map(item => ({ ...item, related: { ...(item.related || {}), code: undefined } })) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/cards') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.cards.map(card => ({ ...card, purchaseCount: db.purchases.filter(item => item.cardId === card.id).length, redeemedCount: db.codes.filter(item => item.cardId === card.id && item.status === 'redeemed').length }));
      return json(res, 200, adminPage(items.sort((a, b) => String(a.title).localeCompare(String(b.title))), url, [item => item.id, item => item.title, item => item.category, item => item.series], 'active'));
    }
    if (req.method === 'GET' && pathname === '/api/admin/purchases') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.purchases.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminPurchaseRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.orderId, item => item.reference, item => item.userName, item => item.userEmail, item => item.cardTitle]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/deposits') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.deposits.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminDepositRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.transactionId, item => item.reference, item => item.paystackReference, item => item.userName, item => item.userEmail]));
    }
    // Card payments, newest first. Filter with ?status=PAID_UNFULFILLED to find charges that need a manual refund.
    if (req.method === 'GET' && pathname === '/api/admin/card-payments') {
      if (!requireAdmin(req, res, db)) return;
      const status = String(url.searchParams.get('status') || '');
      const items = db.cardPayments.filter(item => !status || item.status === status)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .map(item => { const user = db.users.find(u => u.id === item.userId); const { authorizationUrl, callbackUrl, ...safe } = item; return { ...safe, userName: user?.name || 'Unknown user', userEmail: user?.email || '' }; });
      return json(res, 200, { items, total: items.length });
    }
    if (req.method === 'GET' && pathname === '/api/admin/redemptions') {
      if (!requireAdmin(req, res, db)) return;
      const cardMap = new Map(db.cards.map(item => [item.id, item])); const userMap = new Map(db.users.map(item => [item.id, item]));
      const items = db.codes.filter(item => item.status === 'redeemed').sort((a, b) => String(b.redeemedAt || '').localeCompare(String(a.redeemedAt || ''))).map(item => adminSafeCode(item, cardMap.get(item.cardId), userMap.get(item.userId)));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.orderId, item => item.redemptionReference, item => item.userName, item => item.cardTitle]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/withdrawals') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.withdrawals.filter(item => !item.isRefund).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminWithdrawalRow(db, item));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.reference, item => item.userName, item => item.userEmail, item => item.method?.network, item => item.method?.phone]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/kyc') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.users.filter(item => item.kycSubmission || item.kycStatus === KYC_STATUS.PENDING || item.kycStatus === KYC_STATUS.VERIFIED || item.kycStatus === KYC_STATUS.REJECTED).sort((a, b) => String(b.kycSubmittedAt || b.createdAt || '').localeCompare(String(a.kycSubmittedAt || a.createdAt || ''))).map(item => ({ ...adminSafeUser(item, db), documents: item.kycSubmission?.documents || [], submission: item.kycSubmission || null }));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.name, item => item.email, item => item.phone], 'kycStatus'));
    }
    if (req.method === 'GET' && pathname === '/api/admin/transactions') {
      if (!requireAdmin(req, res, db)) return;
      const items = db.transactions.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(item => adminTransactionRow(db, item)).map(item => ({ ...item, related: { ...(item.related || {}), code: undefined } }));
      return json(res, 200, adminPage(items, url, [item => item.id, item => item.reference, item => item.reason, item => item.account, item => item.userName, item => item.userEmail]));
    }
    if (req.method === 'GET' && pathname === '/api/admin/audit-logs') {
      if (!requireAdmin(req, res, db)) return;
      return json(res, 200, adminPage(db.adminAuditLogs.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), url, [item => item.action, item => item.targetType, item => item.targetId, item => item.adminEmail, item => item.reason]));
    }
    if (req.method === 'GET' && /^\/api\/admin\/reconciliation\/[^/]+$/.test(pathname)) {
      if (!requireAdmin(req, res, db)) return;
      const reference = decodeURIComponent(pathname.split('/')[4]); const deposit = db.deposits.find(item => item.transactionId === reference || item.reference === reference || item.paystackReference === reference);
      if (!deposit) return fail(res, 404, 'Deposit was not found.');
      const payment = (db.kycBypassPayments || []).find(item => item.reference === reference || item.paystackReference === reference);
      return json(res, 200, { deposit: adminDepositRow(db, deposit), hub: { reference: deposit.paystackReference || null, checkoutUrl: deposit.authorizationUrl || null, amountMinor: deposit.amountMinor || null, currency: deposit.currency || PAYSTACK_CURRENCY, status: deposit.status === 'SUCCESS' ? 'SUCCESS' : deposit.status }, relatedKycBypass: payment || null });
    }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/approve$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const approved = approveWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.approve', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:approved]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(approved.withdrawal), transaction: approved.transaction && publicTransaction(approved.transaction), receipt: approved.receipt && publicReceipt(approved.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/reject$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const ref = decodeURIComponent(pathname.split('/')[4]); const withdrawal = db.withdrawals.find(item => item.reference === ref); if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.'); const before = { ...withdrawal }; const p = await body(req); const rejected = rejectWithdrawal(db, withdrawal, p.note); adminAudit(db, { admin, action: 'withdrawal.reject', targetType: 'withdrawal', targetId: ref, before, after: { ...withdrawal }, reason: p.note }); save(db); console.log('[withdrawal:rejected]', ref); return json(res, 200, { ok: true, withdrawal: publicWithdrawal(rejected.withdrawal), transaction: rejected.transaction && publicTransaction(rejected.transaction), receipt: rejected.receipt && publicReceipt(rejected.receipt) }); }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/kyc\/verify$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId); if (!target) return fail(res, 404, 'User was not found.'); const p = await body(req); const before = { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }; target.kycStatus = KYC_STATUS.VERIFIED; target.kycVerifiedAt = now(); const released = markWithdrawalKycReady(db, target.id, p.note); adminAudit(db, { admin, action: 'kyc.verify', targetType: 'user', targetId: userId, before, after: { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt, releasedWithdrawals: released.map(item => item.reference) }, reason: p.note }); save(db); console.log('[kyc:verified]', userId, released.length); return json(res, 200, { ok: true, user: adminSafeUser(target, db), releasedWithdrawals: released.map(publicWithdrawal) }); }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/kyc\/reject$/.test(pathname)) { const admin = requireAdmin(req, res, db); if (!admin) return; const userId = decodeURIComponent(pathname.split('/')[4]); const target = db.users.find(item => item.id === userId); if (!target) return fail(res, 404, 'User was not found.'); const p = await body(req); const before = { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }; target.kycStatus = KYC_STATUS.REJECTED; target.kycVerifiedAt = null; adminAudit(db, { admin, action: 'kyc.reject', targetType: 'user', targetId: userId, before, after: { kycStatus: target.kycStatus, kycVerifiedAt: target.kycVerifiedAt }, reason: p.note }); save(db); console.log('[kyc:rejected]', userId); return json(res, 200, { ok: true, user: adminSafeUser(target, db) }); }
    if (req.method === 'POST' && (pathname === '/api/admin/settings' || pathname === '/api/admin/settings/withdrawal-cards')) {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const p = await body(req);
      // Legacy alias: { count } only changes the withdrawal card requirement.
      const input = pathname.endsWith('withdrawal-cards') ? { minPurchasedCardsForWithdrawal: p.count } : p;
      const fields = { minWithdrawal: false, minPurchasedCardsForWithdrawal: true, dailyPurchaseLimit: true, tierPurchaseLimit: true, operationalChargeRate: false, kycBypassFee: false, rewardMultiplierMin: false, rewardMultiplierMax: false };
      const labels = { minWithdrawal: 'Minimum withdrawal', minPurchasedCardsForWithdrawal: 'Cards required to withdraw', dailyPurchaseLimit: 'Daily purchase limit', tierPurchaseLimit: 'Purchases before a tier closes', operationalChargeRate: 'Operational charge', kycBypassFee: 'KYC bypass fee', rewardMultiplierMin: 'Reward multiplier (min)', rewardMultiplierMax: 'Reward multiplier (max)' };
      const before = currentSettings(db);
      const next = { ...before };
      let changedAny = false;
      for (const [key, integer] of Object.entries(fields)) {
        if (!(key in input)) continue;
        const raw = input[key];
        const n = (raw === null || raw === undefined || String(raw).trim() === '') ? NaN : Number(raw);
        const { min, max } = SETTING_LIMITS[key];
        if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
          return fail(res, 400, integer ? `${labels[key]}: enter a whole number from ${min} to ${max}.` : `${labels[key]}: enter a number from ${min} to ${max}.`);
        }
        next[key] = integer ? n : Math.round(n * 10000) / 10000;
        changedAny = true;
      }
      if (!changedAny) return fail(res, 400, 'No settings were provided.');
      if (next.rewardMultiplierMin > next.rewardMultiplierMax) return fail(res, 400, 'Reward multiplier (min) cannot be higher than the maximum.');
      db.settings = next;
      applySettings(next);
      db.cards = syncCardCatalog(db.cards); // reward ranges shown on cards follow the new multipliers
      adminAudit(db, { admin, action: 'settings.update', targetType: 'settings', targetId: 'settings', before, after: next, reason: String(p.note || '').slice(0, 500) });
      save(db);
      console.log('[settings:update]', JSON.stringify(before), '->', JSON.stringify(next));
      return json(res, 200, { ok: true, settings: { ...next, maxWithdrawalCardRequirement: MAX_WITHDRAWAL_CARD_REQUIREMENT, limits: SETTING_LIMITS }, minPurchasedCardsForWithdrawal: next.minPurchasedCardsForWithdrawal });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/balance-purchase$/.test(pathname)) {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const target = db.users.find(item => item.id === userId);
      if (!target) return fail(res, 404, 'User was not found.');
      const p = await body(req);
      if (typeof p.enabled !== 'boolean') return fail(res, 400, 'Send enabled as true or false.');
      const before = { canBuyWithBalance: Boolean(target.canBuyWithBalance) };
      target.canBuyWithBalance = p.enabled;
      adminAudit(db, { admin, action: p.enabled ? 'user.balancePurchase.enable' : 'user.balancePurchase.disable', targetType: 'user', targetId: userId, before, after: { canBuyWithBalance: target.canBuyWithBalance }, reason: String(p.note || '').slice(0, 500) });
      save(db);
      console.log('[user:balance-purchase]', userId, target.canBuyWithBalance);
      return json(res, 200, { ok: true, user: adminSafeUser(target, db) });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/block$/.test(pathname)) {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const target = db.users.find(item => item.id === userId);
      if (!target) return fail(res, 404, 'User was not found.');
      const p = await body(req);
      const before = { blocked: Boolean(target.blocked), blockedReason: target.blockedReason || null };
      target.blocked = true;
      target.blockedAt = now();
      target.blockedReason = String(p.note || '').trim().slice(0, 500) || null;
      // Cut off any session immediately rather than waiting for it to expire or for the
      // next login attempt — requireUser() also re-checks blocked on every request, so
      // this is belt-and-suspenders for anyone already mid-session.
      db.sessions = db.sessions.filter(session => session.userId !== target.id);
      adminAudit(db, { admin, action: 'user.block', targetType: 'user', targetId: userId, before, after: { blocked: true, blockedAt: target.blockedAt, blockedReason: target.blockedReason }, reason: p.note });
      save(db);
      console.log('[user:blocked]', userId);
      return json(res, 200, { ok: true, user: adminSafeUser(target, db) });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/unblock$/.test(pathname)) {
      const admin = requireAdmin(req, res, db); if (!admin) return;
      const userId = decodeURIComponent(pathname.split('/')[4]);
      const target = db.users.find(item => item.id === userId);
      if (!target) return fail(res, 404, 'User was not found.');
      const p = await body(req);
      const before = { blocked: Boolean(target.blocked), blockedReason: target.blockedReason || null };
      target.blocked = false;
      target.blockedAt = null;
      target.blockedReason = null;
      adminAudit(db, { admin, action: 'user.unblock', targetType: 'user', targetId: userId, before, after: { blocked: false }, reason: p.note });
      save(db);
      console.log('[user:unblocked]', userId);
      return json(res, 200, { ok: true, user: adminSafeUser(target, db) });
    }
    if (req.method === 'POST' && pathname === '/api/auth/signup') { const p = await body(req); const email = normalizeEmail(p.email); const phone = normalizePhone(p.phone); if (!p.name?.trim() || !validMobile(phone)) return fail(res, 400, 'Enter your full name and a 10-digit mobile number that starts with 0.'); if (!validGmail(email)) return fail(res, 400, 'Email must be a valid @gmail.com address.'); if (String(p.password || '').length < 6) return fail(res, 400, 'Password must be at least 6 characters.'); if (db.users.some(u => normalizePhone(u.phone) === phone)) return fail(res, 409, 'An account already exists for this mobile number.'); if (db.users.some(u => normalizeEmail(u.email) === email)) return fail(res, 409, 'An account already exists for this email.'); const user = { id: uid('usr'), name: p.name.trim(), email, phone, contactEmailCapturedAt: now(), passwordHash: await hash(p.password), pinHash: null, walletBalance: 0, redeemedBalance: 0, kycStatus: KYC_STATUS.NOT_VERIFIED, kycVerifiedAt: null, createdAt: now() }; db.users.push(user); const token = crypto.randomBytes(32).toString('hex'); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE }); save(db); return json(res, 201, publicState(db, user), { 'set-cookie': sessionCookie(token, req) }); }
    if (req.method === 'POST' && pathname === '/api/auth/login') { const p = await body(req); const identifier = String(p.email || '').trim(); const user = db.users.find(u => normalizeEmail(u.email) === normalizeEmail(identifier) || normalizePhone(u.phone) === normalizePhone(identifier)); if (!user || !await passwordMatches(p.password || '', user.passwordHash)) return fail(res, 401, 'Incorrect email or mobile number, or password.'); if (user.blocked) return fail(res, 403, 'Your account has been blocked. Contact support for help.'); const token = crypto.randomBytes(32).toString('hex'); db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE }); save(db); return json(res, 200, publicState(db, user), { 'set-cookie': sessionCookie(token, req) }); }
    if (req.method === 'POST' && pathname === '/api/auth/logout') { const token = cookie(req).phantom_session; db.sessions = db.sessions.filter(s => s.token !== token); save(db); return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(req) }); }
    if (req.method === 'POST' && pathname === '/api/auth/forgot') {
      const p = await body(req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email || '')) return fail(res, 400, 'Enter a valid email address.');
      const user = db.users.find(u => u.email === p.email.toLowerCase());
      let resetToken = null;
      if (user) {
        resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        db.passwordResets = db.passwordResets.filter(item => item.userId !== user.id || item.status !== 'active');
        db.passwordResets.push({ id: uid('reset'), userId: user.id, tokenHash, createdAt: now(), expiresAt: Date.now() + 1000 * 60 * 30, status: 'active' });
        save(db);
      }
      // A mail provider is not configured for this local app. Returning the token outside
      // production keeps the complete recovery flow testable without exposing it in production.
      return json(res, 200, {
        message: 'If an account exists, a password reset link has been sent.',
        ...(process.env.NODE_ENV === 'production' ? {} : { resetToken }),
      });
    }
    if (req.method === 'POST' && pathname === '/api/auth/reset') {
      const p = await body(req);
      const token = String(p.token || '');
      if (!token) return fail(res, 400, 'This password reset link is missing or invalid.');
      if (String(p.newPassword || '').length < 6) return fail(res, 400, 'Password must be at least 6 characters.');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const reset = db.passwordResets.find(item => item.tokenHash === tokenHash && item.status === 'active');
      if (!reset || Number(reset.expiresAt) < Date.now()) return fail(res, 400, 'This password reset link has expired. Request a new one.');
      const resetUser = db.users.find(item => item.id === reset.userId);
      if (!resetUser) return fail(res, 400, 'This password reset link is invalid.');
      resetUser.passwordHash = await hash(p.newPassword);
      reset.status = 'used';
      reset.usedAt = now();
      save(db);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/purchases') return handlePurchaseRequest(req, res);
    if (req.method === 'POST' && pathname === '/api/purchases/balance') return handleBalancePurchaseRequest(req, res);
    if (req.method === 'POST' && pathname === '/api/claim-gift') return handleClaimGiftRequest(req, res);
    const user = requireUser(req, res, db); if (!user) return;
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, publicState(db, user));
    if (req.method === 'POST' && pathname === '/api/auth/password') { const p = await body(req); if (!await passwordMatches(String(p.currentPassword || ''), user.passwordHash)) return fail(res, 401, 'Current password is incorrect.'); if (String(p.newPassword || '').length < 6) return fail(res, 400, 'New password must be at least 6 characters.'); user.passwordHash = await hash(p.newPassword); save(db); return json(res, 200, { ok: true, state: publicState(db, user) }); }
    if (req.method === 'POST' && pathname === '/api/auth/pin') { const p = await body(req); if (!/^\d{4}$/.test(p.newPin || '')) return fail(res, 400, 'New withdrawal PIN must be four digits.'); if (user.pinHash && !await passwordMatches(String(p.currentPin || ''), user.pinHash)) return fail(res, 401, 'Current withdrawal PIN is incorrect.'); user.pinHash = await hash(p.newPin); save(db); return json(res, 200, { ok: true, state: publicState(db, user) }); }
    if (req.method === 'GET' && /^\/api\/card-payments\/[^/]+$/.test(pathname)) {
      const transactionId = decodeURIComponent(pathname.split('/')[3]);
      const payment = db.cardPayments.find(x => x.transactionId === transactionId && x.userId === user.id);
      if (!payment) return fail(res, 404, 'Card payment was not found.');
      const purchase = payment.purchaseId ? db.purchases.find(x => x.id === payment.purchaseId) : null;
      return json(res, 200, { payment: publicCardPayment(payment), purchase: purchase && publicPurchase(purchase), state: publicState(db, user) });
    }
    if (req.method === 'POST' && /^\/api\/purchases\/[^/]+\/code\/?$/.test(pathname)) {
      const purchaseId = decodeURIComponent(pathname.split('/')[3]);
      const purchase = db.purchases.find(item => item.id === purchaseId && item.userId === user.id);
      if (!purchase) return fail(res, 404, 'Purchased card was not found.');
      const code = db.codes.find(item => item.purchaseId === purchase.id && item.userId === user.id);
      if (!code || purchase.status !== 'sealed' || code.status !== 'unused') return fail(res, 409, 'This card is no longer available to redeem.');
      const card = db.cards.find(item => item.id === purchase.cardId);
      return json(res, 200, { purchase: publicPurchase(purchase), card: card && publicCard(card), code: code.code });
    }
    if (req.method === 'POST' && pathname === '/api/redemptions') {
      const p = await body(req);
      const codeText = normalizeCode(p.code);
      if (!CODE_PATTERN.test(codeText)) return fail(res, 400, 'Enter a valid 14-character redemption code.');
      const code = db.codes.find(c => normalizeCode(c.code) === codeText);
      if (!code) return fail(res, 404, 'That redemption code does not exist.');
      if (code.userId !== user.id) return fail(res, 403, 'This code belongs to another account.');
      if (code.status !== 'unused') return fail(res, 409, 'This code has already been redeemed.');
      const card = db.cards.find(c => c.id === code.cardId);
      const purchase = db.purchases.find(item => item.id === code.purchaseId && item.userId === user.id);
      const purchaseAmount = money(code.purchaseAmount ?? purchase?.amountPaid ?? card?.priceGhs ?? 0);
      let rewardAmount = money(code.rewardAmount ?? purchase?.rewardAmount ?? card?.rewardAmount ?? 0);
      let rewardMultiplier = Number(code.rewardMultiplier ?? purchase?.rewardMultiplier ?? rewardMultiplierForAmount(rewardAmount, purchaseAmount));
      // Unused legacy codes may have been created under an older multiplier
      // range. Reassign only those future redemptions; completed redemptions
      // remain historical snapshots and are never rewritten.
      if (!validRewardMultiplier(rewardMultiplier)) {
        const reward = rewardAllocationForPrice(purchaseAmount);
        rewardAmount = reward.rewardAmount;
        rewardMultiplier = reward.rewardMultiplier;
        if (purchase) {
          purchase.rewardAmount = rewardAmount;
          purchase.rewardMultiplier = rewardMultiplier;
        }
      }
      if (!Number.isFinite(rewardAmount) || rewardAmount <= 0 || !validRewardMultiplier(rewardMultiplier)) return fail(res, 400, 'This code has no valid reward value.');
      code.amount = rewardAmount;
      code.rewardAmount = rewardAmount;
      code.rewardMultiplier = rewardMultiplier;
      code.purchaseAmount = purchaseAmount;
      code.status = 'redeemed';
      code.redeemedAt = now();
      const ref = uniqueReference(db, 'RED');
      code.redemptionReference = ref;
      balance(user, 'redeemed', rewardAmount);
      transaction(db, { userId: user.id, type: 'credit', amount: rewardAmount, account: 'redeemed', reference: ref, reason: 'Redeemed code', related: { cardId: code.cardId, orderId: code.orderId, code: code.code, purchaseAmount, rewardAmount, rewardMultiplier } });
      const rcpt = receipt(db, { userId: user.id, type: 'redemption', amount: rewardAmount, account: 'redeemed', reference: ref, related: { cardId: code.cardId, orderId: code.orderId, code: code.code, purchaseAmount, rewardAmount, rewardMultiplier } });
      save(db);
      console.log('[redemption:complete]', ref, { purchaseAmount, rewardAmount, rewardMultiplier });
      return json(res, 200, { state: publicState(db, user), code: publicCode(code, card), receipt: publicReceipt(rcpt) });
    }
    if (req.method === 'POST' && pathname === '/api/methods') { const p = await body(req); const networks = ['MTN Mobile Money', 'Telecel Cash', 'AT Cash']; if (!networks.includes(p.network) || !p.accountName?.trim() || String(p.phone || '').replace(/\D/g, '').length < 9) return fail(res, 400, 'Enter a supported mobile money method, account name, and valid phone number.'); if (!/^\d{4}$/.test(p.pin || '')) return fail(res, 400, 'Withdrawal PIN must be four digits.'); if (user.pinHash && !await passwordMatches(String(p.pin || ''), user.pinHash)) return fail(res, 401, 'Incorrect withdrawal PIN.'); if (!user.pinHash) user.pinHash = await hash(p.pin); const method = { id: uid('method'), userId: user.id, network: p.network, accountName: p.accountName.trim(), phone: p.phone.trim(), isDefault: !db.methods.some(m => m.userId === user.id), createdAt: now() }; db.methods.push(method); save(db); return json(res, 201, { state: publicState(db, user), method }); }
    if (req.method === 'POST' && pathname === '/api/withdrawals') {
      const p = await body(req);
      const requestedAmount = money(p.amount);
      const method = db.methods.find(m => m.id === p.methodId && m.userId === user.id);
      // The GHS withdrawal limit is checked first, before the card-count requirement.
      if (user.redeemedBalance < MIN_WITHDRAWAL) {
        const hasPurchasedCard = db.purchases.some(item => item.userId === user.id && !item.isFreeGift && Number(item.amountPaid ?? item.amount ?? 0) > 0);
        return fail(res, 400, hasPurchasedCard
          ? `Withdrawals start at GHS ${MIN_WITHDRAWAL.toFixed(2)}. Your redeemed balance is GHS ${money(user.redeemedBalance).toFixed(2)}, so redeem more cards to reach it.`
          : `Withdrawals start at GHS ${MIN_WITHDRAWAL.toFixed(2)}. Purchase and redeem your first card to reach it.`);
      }
      const purchasedCards = purchasedCardsCount(db, user.id);
      const requiredCards = withdrawalCardRequirement(db);
      if (purchasedCards < requiredCards) {
        const remaining = Math.max(0, requiredCards - purchasedCards);
        return fail(res, 400, `Purchase ${remaining} more card${remaining === 1 ? '' : 's'} to unlock withdrawals.`);
      }
      if (!method) return fail(res, 400, 'Choose a saved withdrawal method.');
      if (!Number.isFinite(requestedAmount) || requestedAmount < MIN_WITHDRAWAL) return fail(res, 400, `Minimum withdrawal is GHS ${MIN_WITHDRAWAL.toFixed(2)}.`);
      if (requestedAmount > user.redeemedBalance) return fail(res, 400, 'Withdrawal amount exceeds redeemed balance.');
      if (!user.pinHash || !await passwordMatches(String(p.pin || ''), user.pinHash)) return fail(res, 401, 'Incorrect withdrawal PIN.');
      const operationalCharge = money(requestedAmount * OPERATIONAL_CHARGE_RATE);
      const actualAmount = money(requestedAmount - operationalCharge);
      const kycRequired = user.kycStatus !== KYC_STATUS.VERIFIED;
      if (kycRequired && p.kycPayWith === 'redeemed_balance') {
        // Users an admin has approved for balance payments can settle the one-time KYC fee
        // from their redeemed balance instead of the secure checkout. Everything below is
        // synchronous, so the checks and the deductions cannot race with another request.
        if (!user.canBuyWithBalance) return fail(res, 403, 'Paying with your balance is not enabled for your account.');
        const needed = money(requestedAmount + KYC_BYPASS_FEE);
        if (money(user.redeemedBalance) < needed) return fail(res, 402, `Paying the GHS ${KYC_BYPASS_FEE.toFixed(2)} KYC fee from your balance needs GHS ${needed.toFixed(2)} (withdrawal + fee). Your redeemed balance is GHS ${money(user.redeemedBalance).toFixed(2)}. Lower the withdrawal or use the secure checkout instead.`);
        const intent = { methodId: method.id, requestedAmount, operationalCharge, actualAmount };
        const payment = { id: uid('kycbyp'), userId: user.id, withdrawalId: null, withdrawalReference: null, withdrawalIntent: intent, amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, reference: uniqueReference(db, 'KYC'), status: 'initialized', paidWith: 'redeemed_balance', callbackUrl: '', expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), createdAt: now(), updatedAt: now() };
        db.kycBypassPayments.push(payment);
        balance(user, 'redeemed', -KYC_BYPASS_FEE);
        const result = completeKycBypassPayment(db, payment, 'redeemed_balance');
        if (!result.withdrawal) { balance(user, 'redeemed', KYC_BYPASS_FEE); db.kycBypassPayments = db.kycBypassPayments.filter(item => item.id !== payment.id); return fail(res, 409, 'Withdrawal could not be created. Please try again.'); }
        payment.status = 'success';
        save(db);
        console.log('[withdrawal:kyc-paid-from-balance]', payment.reference, result.withdrawal.reference);
        return json(res, 201, { paidWithBalance: true, state: publicState(db, user), withdrawal: publicWithdrawal(result.withdrawal), receipt: publicReceipt(db.receipts.find(r => r.reference === result.withdrawal.reference)), kycReceipt: publicReceipt(result.receipt) });
      }
      if (kycRequired) {
        // KYC fee not paid yet: do NOT deduct the balance and do NOT create a withdrawal
        // (so nothing shows as pending). We only remember the request on the payment
        // record; the withdrawal is created after the KYC fee is confirmed as paid.
        if (!HUB_BASE_URL || !HUB_API_KEY || !HUB_API_SECRET) return fail(res, 503, 'Secure KYC payment checkout is not configured.');
        const preview = { requestedAmount, operationalCharge, actualAmount };
        const intent = { methodId: method.id, ...preview };
        const reusable = db.kycBypassPayments.find(item => !item.withdrawalId && item.userId === user.id && item.status === 'PAYMENT_INITIALIZED' && item.authorizationUrl && Number(item.amount) === KYC_BYPASS_FEE && new Date(item.expiresAt).getTime() > Date.now() && item.withdrawalIntent?.methodId === method.id && Number(item.withdrawalIntent?.requestedAmount) === requestedAmount);
        if (reusable) return json(res, 200, { kycRequired: true, reference: reusable.reference, checkoutUrl: reusable.authorizationUrl, amount: KYC_BYPASS_FEE, mode: 'hub', callbackUrl: reusable.callbackUrl, withdrawalPreview: preview, state: publicState(db, user) });
        const payment = { id: uid('kycbyp'), userId: user.id, withdrawalId: null, withdrawalReference: null, withdrawalIntent: intent, amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, reference: uniqueReference(db, 'KYC'), status: 'initialized', callbackUrl: '', returnOrigin: normalizeOrigin(p.returnOrigin), expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), createdAt: now(), updatedAt: now() };
        payment.callbackUrl = kycBypassCallback(req, payment.reference, p.returnOrigin);
        db.kycBypassPayments.push(payment);
        save(db);
        try {
          const result = await hubCall('POST', '/transaction/initialize', {
            email: paystackEmailForUser(user), amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, redirectUrl: `${hubReturnOrigin(req, p.returnOrigin)}/api/payment/return`,
            metadata: { site: 'PHANTOM_CARDS', transactionId: payment.reference, userId: user.id, purpose: 'KYC_BYPASS' },
          });
          payment.status = 'PAYMENT_INITIALIZED'; payment.paystackReference = result.reference; payment.authorizationUrl = result.checkoutUrl; payment.updatedAt = now(); save(db);
          console.log('[withdrawal:kyc-payment-required]', payment.reference, preview);
          return json(res, 201, { kycRequired: true, reference: payment.reference, checkoutUrl: result.checkoutUrl, amount: KYC_BYPASS_FEE, mode: 'hub', callbackUrl: payment.callbackUrl, withdrawalPreview: preview, state: publicState(db, user) });
        } catch (error) { payment.status = 'failed'; payment.updatedAt = now(); save(db); return fail(res, 502, `Payment initialization failed: ${error.message}`); }
      }
      const status = WITHDRAWAL_STATUS.PENDING;
      const ref = uniqueReference(db, 'WDL');
      balance(user, 'redeemed', -requestedAmount);
      const withdrawal = normalizeWithdrawalRecord({ id: uid('wdl'), userId: user.id, methodId: method.id, amount: requestedAmount, requestedAmount, operationalCharge, actualAmount, reference: ref, status, kycRequired, kycBypassUsed: false, kycBypassFee: 0, paymentStatus: 'not_required', createdAt: now(), approvedAt: null, completedAt: null });
      db.withdrawals.push(withdrawal);
      const related = { withdrawalId: withdrawal.id, methodId: method.id, payoutStatus: status, requestedAmount, operationalCharge, actualAmount, kycRequired, kycBypassUsed: false };
      transaction(db, { userId: user.id, type: 'debit', amount: requestedAmount, account: 'redeemed', reference: ref, status, reason: `Withdrawal to ${method.network}`, related });
      const rcpt = receipt(db, { userId: user.id, type: 'withdrawal', amount: requestedAmount, account: 'redeemed', reference: ref, status, related });
      save(db);
      console.log('[withdrawal:pending]', ref, { requestedAmount, operationalCharge, actualAmount });
      return json(res, 201, { state: publicState(db, user), withdrawal: publicWithdrawal(withdrawal), receipt: publicReceipt(rcpt) });
    }
    if (req.method === 'POST' && /^\/api\/withdrawals\/[^/]+\/kyc-bypass$/.test(pathname)) {
      const withdrawalRef = decodeURIComponent(pathname.split('/')[3]);
      const withdrawal = db.withdrawals.find(item => item.reference === withdrawalRef && item.userId === user.id);
      if (!withdrawal) return fail(res, 404, 'Withdrawal was not found.');
      normalizeWithdrawalRecord(withdrawal);
      if (withdrawal.status !== WITHDRAWAL_STATUS.PENDING_KYC_VERIFICATION) return fail(res, 400, 'KYC bypass is available only for withdrawals pending KYC verification.');
      if (withdrawal.kycBypassUsed) return fail(res, 400, 'KYC bypass has already been used for this withdrawal.');
      if (!HUB_BASE_URL || !HUB_API_KEY || !HUB_API_SECRET) return fail(res, 503, 'Secure KYC payment checkout is not configured.');
      const existing = db.kycBypassPayments.find(item => item.withdrawalId === withdrawal.id && item.userId === user.id && ['initialized', 'PAYMENT_INITIALIZED'].includes(item.status) && Number(item.amount) === KYC_BYPASS_FEE && new Date(item.expiresAt).getTime() > Date.now());
      const payment = existing || { id: uid('kycbyp'), userId: user.id, withdrawalId: withdrawal.id, withdrawalReference: withdrawal.reference, amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, reference: uniqueReference(db, 'KYC'), status: 'initialized', callbackUrl: kycBypassCallback(req, '', ''), returnOrigin: '', expiresAt: new Date(Date.now() + PAYMENT_SESSION_MS).toISOString(), createdAt: now(), updatedAt: now() };
      const p = await body(req);
      payment.callbackUrl = kycBypassCallback(req, payment.reference, p.returnOrigin);
      payment.returnOrigin = normalizeOrigin(p.returnOrigin);
      if (!existing) db.kycBypassPayments.push(payment);
      withdrawal.paymentStatus = 'bypass_initialized';
      save(db);
      // A still-live checkout already exists for this withdrawal (e.g. the user
      // double-clicked, reopened the sheet, or retried after a slow response).
      // Re-initializing with the hub would mint a second Paystack reference and
      // overwrite this record's, orphaning the checkout the user may already be
      // paying on. Hand back the same checkout instead of calling the hub again.
      if (existing && existing.status === 'PAYMENT_INITIALIZED' && existing.authorizationUrl) {
        return json(res, 201, { reference: payment.reference, withdrawal: publicWithdrawal(withdrawal), checkoutUrl: payment.authorizationUrl, amount: KYC_BYPASS_FEE, mode: 'hub', callbackUrl: payment.callbackUrl });
      }
      const redirectUrl = `${hubReturnOrigin(req, p.returnOrigin)}/api/payment/return`;
      try {
        const result = await hubCall('POST', '/transaction/initialize', {
          email: paystackEmailForUser(user), amount: KYC_BYPASS_FEE, currency: PAYSTACK_CURRENCY, redirectUrl,
          metadata: { site: 'PHANTOM_CARDS', transactionId: payment.reference, userId: user.id, purpose: 'KYC_BYPASS' },
        });
        payment.status = 'PAYMENT_INITIALIZED'; payment.paystackReference = result.reference; payment.authorizationUrl = result.checkoutUrl; payment.updatedAt = now(); save(db);
        return json(res, 201, { reference: payment.reference, withdrawal: publicWithdrawal(withdrawal), checkoutUrl: result.checkoutUrl, amount: KYC_BYPASS_FEE, mode: 'hub', callbackUrl: payment.callbackUrl });
      } catch (error) { return fail(res, 502, `Payment initialization failed: ${error.message}`); }
    }
    if (req.method === 'POST' && /^\/api\/kyc-bypass-payments\/[^/]+\/verify$/.test(pathname)) {
      const ref = decodeURIComponent(pathname.split('/')[3]);
      const payment = db.kycBypassPayments.find(item => item.reference === ref && item.userId === user.id);
      if (!payment) return fail(res, 404, 'KYC bypass payment was not found.');
      if (payment.status === 'success') {
        const withdrawal = db.withdrawals.find(item => item.id === payment.withdrawalId);
        return json(res, 200, {
          state: publicState(db, user),
          withdrawal: withdrawal ? publicWithdrawal(withdrawal) : null,
          receipt: db.receipts.find(r => r.reference === ref),
          refundReceipt: withdrawal?.kycBypassRefundReference ? db.receipts.find(r => r.reference === withdrawal.kycBypassRefundReference) : null,
        });
      }
      return fail(res, 409, 'Payment is still being confirmed. Please return to the payment screen shortly.');
    }
    return fail(res, 404, 'API route not found.');
  } catch (error) { console.error('[api:error]', error); return fail(res, 500, error.message || 'Unexpected server error.'); }
}
if (process.argv.includes('--reset')) { save(blankDb()); console.log(`Reset ${DATA_FILE}`); process.exit(0); }
const server = http.createServer(route);
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing server or choose another PORT.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
server.listen(PORT, () => {
  if (appBaseUrlPortMismatch()) {
    console.warn(`[env:warning] Server is listening on port ${PORT}, but APP_BASE_URL is ${APP_BASE_URL}. Set APP_BASE_URL to the public Site A origin.`);
  }
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !process.env.PHANTOM_DATA_FILE) {
    console.warn('=========================================================================');
    console.warn('[env:warning] PHANTOM_DATA_FILE is not set. Data is being written to');
    console.warn(`  ${DATA_FILE}`);
    console.warn('  which lives inside the app directory. On Railway (and most container');
    console.warn('  hosts) that directory is wiped on every redeploy, so ALL users, cards,');
    console.warn('  purchases and withdrawals will be lost the next time you push a change.');
    console.warn('  Fix: create a Railway Volume, mount it at /data, then set');
    console.warn('  PHANTOM_DATA_FILE=/data/phantom-cards.json in the service variables.');
    console.warn('  See DEPLOY.md, section "Persistent storage".');
    console.warn('=========================================================================');
  }
  if (isProduction && !APP_BASE_URL) {
    console.warn('[env:warning] APP_BASE_URL is not set. Payment return/callback URLs fall back');
    console.warn('  to request headers, which can be wrong behind some proxies and can send');
    console.warn('  customers to the wrong place after paying. Set APP_BASE_URL to the public');
    console.warn('  HTTPS URL of this service.');
  }
  if (isProduction && (!HUB_BASE_URL || !HUB_API_KEY || !HUB_API_SECRET)) {
    console.warn('[env:warning] HUB_BASE_URL / HUB_API_KEY / HUB_API_SECRET are not fully set.');
    console.warn('  Card purchases and withdrawals will fail with "Card payments are not');
    console.warn('  configured" until these are set to the credentials issued by the Payment Hub.');
  }
  console.log(`PHANTOM CARDS development server: ${APP_BASE_URL || `http://127.0.0.1:${PORT}`}`);
});
