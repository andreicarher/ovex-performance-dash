// /api/google-ads-data.js
//
// Vercel Serverless Function — the ONLY piece of this project allowed to hold
// Google Ads credentials. Never move this logic into the dashboard's client-side
// JS: anything shipped to the browser is public.
//
// Calls the Google Ads REST API directly (no SDK). Known gotchas baked in:
//   - OAuth Client ID must be type "Aplicación web" (see SETUP.md).
//   - API version is env-configurable — Google deprecates versions ~every 3 quarters.
//   - Never send pageSize (PAGE_SIZE_NOT_SUPPORTED); paginate via nextPageToken.
//   - Response fields are camelCase even though GAQL is snake_case.
//   - Numeric fields come back as STRINGS — always parse them.
//   - Actionable error detail lives in error.details[].errors[].message.
//   - GAQL has no THIS_YEAR literal — ranges are spelled out with BETWEEN.
//
// ---------------------------------------------------------------------------
// Query params (all optional):
//   ?since=YYYY-MM-DD&until=YYYY-MM-DD   custom range (default: DATA_START_DATE → today)
//   ?refresh=<REFRESH_SECRET>            bypass the cache (only if REFRESH_SECRET is set)
//
// Environment variables:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID       (required)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   only if accessed through an MCC
//   GOOGLE_ADS_API_VERSION         default v23
//   DATA_START_DATE                default 2026-01-01
//   REPORT_TIMEZONE                default America/Mexico_City
//   ALLOWED_ORIGIN, REFRESH_SECRET optional (see meta-ads-data.js)
// ---------------------------------------------------------------------------

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v23";
const DATA_START_DATE = process.env.DATA_START_DATE || "2026-01-01";
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "America/Mexico_City";
const MAX_RANGE_DAYS = 3 * 366;

export const config = { maxDuration: 60 };

// ---------------------------------------------------------------------------
// Date range helpers (kept identical to meta-ads-data.js on purpose — each
// function is self-contained so neither depends on shared-module resolution)
// ---------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function todayInTimezone(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isValidIsoDate(s) {
  if (!ISO_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const isoToUtc = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Default DATA_START_DATE → today. Replaces the old "current year only" range,
// which would have silently dropped all of 2026 on January 1st, 2027.
function resolveRange(query) {
  const today = todayInTimezone(REPORT_TIMEZONE);
  const since = query?.since ?? DATA_START_DATE;
  let until = query?.until ?? today;
  if (!isValidIsoDate(since) || !isValidIsoDate(until)) {
    throw httpError(400, "Parámetros since/until inválidos — usa el formato YYYY-MM-DD.");
  }
  if (until > today) until = today;
  if (since > until) throw httpError(400, `Rango vacío: since (${since}) es posterior a until (${until}).`);
  const days = Math.round((isoToUtc(until) - isoToUtc(since)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw httpError(400, `Rango demasiado largo (${days} días, máximo ${MAX_RANGE_DAYS}).`);
  return { since, until };
}

// ---------------------------------------------------------------------------
// OAuth + GAQL
// ---------------------------------------------------------------------------
let tokenCache = { accessToken: null, expiresAt: 0 };
let tokenInFlight = null; // the two parallel queries share one token refresh

const STATUS_MAP = { ENABLED: "Activa", PAUSED: "Pausada", REMOVED: "Removida" };
const num = (v) => (v === undefined || v === null ? 0 : parseFloat(v));
const microsToCurrency = (v) => Math.round((num(v) / 1_000_000) * 100) / 100;

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = (async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`Fallo al refrescar el access token OAuth: ${json.error_description || json.error || JSON.stringify(json)}`);
    }
    tokenCache = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return tokenCache.accessToken;
  })();
  try { return await tokenInFlight; } finally { tokenInFlight = null; }
}

function extractGoogleAdsErrorDetail(json) {
  const topMessage = json?.error?.message || "Error desconocido de Google Ads API";
  const nestedErrors = (json?.error?.details || []).flatMap((d) => d.errors || []);
  const nestedMessages = nestedErrors.map((e) => `${e.errorCode ? JSON.stringify(e.errorCode) + ": " : ""}${e.message}`);
  return nestedMessages.length ? `${topMessage} — ${nestedMessages.join(" | ")}` : topMessage;
}

async function gaqlSearch(query) {
  const accessToken = await getAccessToken();
  const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
  }
  let allRows = [];
  let pageToken;
  do {
    const body = pageToken ? { query, pageToken } : { query }; // no pageSize, ever
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(extractGoogleAdsErrorDetail(json));
    allRows = allRows.concat(json.results || []);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return allRows;
}

async function fetchGoogleAdsData({ since, until }) {
  // Both queries are independent — run them in parallel.
  const [campaignRows, keywordRows] = await Promise.all([
    gaqlSearch(`
      SELECT
        segments.date,
        campaign.name,
        campaign.advertising_channel_type,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
      ORDER BY segments.date ASC
    `),
    gaqlSearch(`
      SELECT
        segments.date,
        campaign.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.status,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions
      FROM keyword_view
      WHERE segments.date BETWEEN '${since}' AND '${until}'
      ORDER BY segments.date ASC
    `),
  ]);

  const campaignDaily = campaignRows.map((r) => ({
    Date: r.segments.date,
    Campaign: r.campaign.name,
    ChannelType: r.campaign.advertisingChannelType,
    Cost: microsToCurrency(r.metrics.costMicros),
    Clicks: num(r.metrics.clicks),
    Impressions: num(r.metrics.impressions),
    Conversions: num(r.metrics.conversions),
  }));

  const keywordDaily = keywordRows.map((r) => ({
    Date: r.segments.date,
    Campaign: r.campaign.name,
    Keyword: r.adGroupCriterion.keyword.text,
    Estado: STATUS_MAP[r.adGroupCriterion.status] || r.adGroupCriterion.status,
    Cost: microsToCurrency(r.metrics.costMicros),
    Clicks: num(r.metrics.clicks),
    Impressions: num(r.metrics.impressions),
    Conversions: num(r.metrics.conversions),
  }));

  return { campaignDaily, keywordDaily, range: { since, until }, fetchedAt: new Date().toISOString(), apiVersion: API_VERSION };
}

// ---------------------------------------------------------------------------
// Cache: per-range, in-memory, 15 min.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS ? hit.data : null;
}
function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { data, fetchedAt: Date.now() });
}

export default async function handler(req, res) {
  if (process.env.ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const range = resolveRange(req.query);
    const secret = process.env.REFRESH_SECRET;
    const forceRefresh = Boolean(secret) && req.query?.refresh === secret;
    const cacheKey = `${range.since}|${range.until}`;

    let data = forceRefresh ? null : cacheGet(cacheKey);
    if (!data) {
      data = await fetchGoogleAdsData(range);
      cacheSet(cacheKey, data);
    }
    res.setHeader("Cache-Control", forceRefresh ? "no-store" : "s-maxage=900, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Google Ads API error:", err);
    return res.status(err.status || 502).json({
      error: err.status === 400 ? "Solicitud inválida" : "No se pudo obtener datos de Google Ads",
      detail: err.message || String(err),
    });
  }
}
