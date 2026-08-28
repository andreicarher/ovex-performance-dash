// /api/google-ads-data.js
//
// Vercel Serverless Function — the ONLY piece of this project allowed to hold
// Google Ads credentials. Never move this logic into the dashboard's client-side
// JS: anything shipped to the browser is public.
//
// Implementation notes: this calls the Google Ads REST API directly (no SDK),
// on purpose — it bakes in the lessons learned connecting Google Ads on a
// previous project, so the failure modes are the ones already known instead
// of new ones hidden behind a library:
//   - OAuth Client ID must be type "Aplicación web" (see SETUP.md) — a
//     "desktop" client cannot register the OAuth Playground's redirect URI.
//   - API version is env-configurable, not hardcoded — Google deprecates
//     Google Ads API versions aggressively (roughly every ~3 quarters).
//   - Never send pageSize — the API fixes it at 10,000 rows and rejects the
//     param with PAGE_SIZE_NOT_SUPPORTED if you set it.
//   - Response fields are camelCase (costMicros, advertisingChannelType)
//     even though the GAQL query itself is written in snake_case.
//   - Numeric fields (cost_micros, clicks, impressions) come back as STRINGS
//     in the REST response — always parseInt/parseFloat them.
//   - The top-level error.message is usually generic ("Request contains an
//     invalid argument."); the actionable detail is nested in
//     error.details[].errors[].message — always surface that, not just the
//     top-level message, or every failure turns into a guessing game.

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v23";

// GAQL's DURING operator only accepts a fixed set of literals (LAST_30_DAYS,
// THIS_MONTH, YESTERDAY, etc.) — there is no THIS_YEAR/LAST_YEAR literal.
// A full-year range has to be spelled out explicitly with BETWEEN.
function currentYearRange() {
  const year = new Date().getFullYear();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// ---------------------------------------------------------------------------
// Caching. Two layers:
//  1. Access token cache (OAuth tokens last ~1h — no need to refresh every call).
//  2. Report data cache (15 min TTL) so dashboard traffic doesn't hammer the
//     Ads API or its quota.
// Both are in-memory and only persist while the serverless instance stays
// "warm" — Vercel does not guarantee the same instance handles the next
// request, so this reduces calls but is not a durable cache. If you need
// guaranteed hourly-fresh data regardless of cold starts, the next step is
// Vercel KV + a Cron Job writing into it on a schedule (see SETUP.md, step 6).
// ---------------------------------------------------------------------------
let tokenCache = { accessToken: null, expiresAt: 0 };
let dataCache = { data: null, fetchedAt: 0 };
const DATA_CACHE_TTL_MS = 15 * 60 * 1000;

const STATUS_MAP = { ENABLED: "Activa", PAUSED: "Pausada", REMOVED: "Removida" };
const microsToCurrency = (v) => (v === undefined || v === null ? 0 : parseFloat(v) / 1_000_000);
const num = (v) => (v === undefined || v === null ? 0 : parseFloat(v));

async function getAccessToken() {
  const now = Date.now();
  // 60s safety margin before actual expiry
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }
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
    throw new Error(
      `Fallo al refrescar el access token OAuth: ${json.error_description || json.error || JSON.stringify(json)}`
    );
  }
  tokenCache = { accessToken: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return tokenCache.accessToken;
}

// Pulls the real, actionable error out of a Google Ads API error response.
// The top-level message is almost always useless on its own — see notes above.
function extractGoogleAdsErrorDetail(json) {
  const topMessage = json?.error?.message || "Error desconocido de Google Ads API";
  const nestedErrors = (json?.error?.details || []).flatMap((d) => d.errors || []);
  const nestedMessages = nestedErrors.map(
    (e) => `${e.errorCode ? JSON.stringify(e.errorCode) + ": " : ""}${e.message}`
  );
  return nestedMessages.length ? `${topMessage} — ${nestedMessages.join(" | ")}` : topMessage;
}

async function gaqlSearch(query) {
  const accessToken = await getAccessToken();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  let allRows = [];
  let pageToken;
  do {
    // Deliberately no `pageSize` field here — see file header notes.
    const body = pageToken ? { query, pageToken } : { query };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(extractGoogleAdsErrorDetail(json));
    allRows = allRows.concat(json.results || []);
    pageToken = json.nextPageToken;
  } while (pageToken);

  return allRows;
}

async function fetchGoogleAdsData() {
  const { start, end } = currentYearRange();

  // Campaign-level daily performance — replaces the "Query Google 2026" Sheet tab.
  // `campaign.advertising_channel_type` is included so Performance Max campaigns
  // (which DO show up here automatically, unlike some other ad platforms) can be
  // told apart from Search if that's ever useful — no separate query needed for them.
  const campaignRows = await gaqlSearch(`
    SELECT
      segments.date,
      campaign.name,
      campaign.advertising_channel_type,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
    ORDER BY segments.date ASC
  `);

  const campaignDaily = campaignRows.map((r) => ({
    Date: r.segments.date, // "YYYY-MM-DD"
    Campaign: r.campaign.name,
    ChannelType: r.campaign.advertisingChannelType, // camelCase in the response
    Cost: microsToCurrency(r.metrics.costMicros), // string micros -> number currency
    Clicks: num(r.metrics.clicks),
    Impressions: num(r.metrics.impressions),
    Conversions: num(r.metrics.conversions),
  }));

  // Keyword-level daily performance — the real cost-per-keyword data the Sheet
  // could never provide.
  const keywordRows = await gaqlSearch(`
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
    WHERE segments.date BETWEEN '${start}' AND '${end}'
    ORDER BY segments.date ASC
  `);

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

  return { campaignDaily, keywordDaily, fetchedAt: new Date().toISOString(), apiVersion: API_VERSION };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const now = Date.now();
    const forceRefresh = req.query?.refresh === "1";
    if (!dataCache.data || forceRefresh || now - dataCache.fetchedAt > DATA_CACHE_TTL_MS) {
      dataCache = { data: await fetchGoogleAdsData(), fetchedAt: now };
    }
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    return res.status(200).json(dataCache.data);
  } catch (err) {
    // Surface the FULL detail (see extractGoogleAdsErrorDetail) — a generic
    // 500 with just err.message turns every failure into a guessing game.
    console.error("Google Ads API error:", err);
    return res.status(502).json({
      error: "No se pudo obtener datos de Google Ads",
      detail: err.message || String(err),
    });
  }
}
