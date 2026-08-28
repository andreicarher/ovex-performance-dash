// /api/meta-ads-data.js
//
// Vercel Serverless Function — the ONLY piece of this project allowed to hold
// the Meta access token. Never move this logic into the dashboard's client-side
// JS: anything shipped to the browser is public.
//
// Auth: System User access token (from Business Manager > System Users).
// Unlike Google Ads, this does NOT expire and needs no refresh flow — it's
// just a bearer credential passed as a query param on every call. Much
// simpler than the Google Ads integration for that reason alone.
//
// IMPORTANT — things intentionally NOT hardcoded, on purpose:
//   - API_VERSION: the Marketing API deprecates on a much more aggressive
//     ~90-day clock than the general Graph API (~2 years). Check
//     developers.facebook.com/docs/graph-api/changelog periodically and bump
//     META_API_VERSION in Vercel — don't wait for it to break.
//   - The exact `action_type` for "registration completed": Meta's `actions`
//     array reports every tracked conversion under a generic
//     {action_type, value} shape, and the exact string for something like
//     "completed registration" depends on how THIS account's Pixel/Conversions
//     API events are configured (could be `lead`, a custom conversion name,
//     `offsite_conversion.fb_pixel_complete_registration`, etc.). Rather than
//     guess, this endpoint returns the full raw `actions` array alongside a
//     couple of high-confidence named extracts, so the real action_type can
//     be read off a real response and added as a named field once confirmed.

const API_VERSION = process.env.META_API_VERSION || "v26.0";

// ---------------------------------------------------------------------------
// Caching: no token cache needed (System User tokens don't expire), just a
// short data cache so dashboard traffic doesn't hammer the API. In-memory,
// so it resets on cold starts — see the Google Ads backend's SETUP.md /
// SKILL.md for the Vercel KV + Cron upgrade path if guaranteed freshness
// across cold starts is ever needed.
// ---------------------------------------------------------------------------
let dataCache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

const num = (v) => (v === undefined || v === null ? 0 : parseFloat(v));

// High-confidence action_type strings — verified against Meta's own Insights
// API docs and independent field-reference sources. Extend this map once a
// real response confirms the account's actual "registration completed" type.
const NAMED_ACTION_TYPES = {
  messagingConversationsStarted: "onsite_conversion.messaging_conversation_started_7d",
  leads: "lead",
};

function extractAction(actionsArray, actionType) {
  if (!Array.isArray(actionsArray)) return 0;
  const match = actionsArray.find((a) => a.action_type === actionType);
  return match ? num(match.value) : 0;
}

function extractErrorDetail(json) {
  const err = json?.error;
  if (!err) return "Error desconocido de Meta Marketing API";
  // error_user_msg is Meta's own "safe to show the end user" message when present.
  const parts = [err.message, err.error_user_msg, err.error_subcode ? `subcode ${err.error_subcode}` : null].filter(Boolean);
  return parts.join(" — ") || "Error desconocido de Meta Marketing API";
}

async function fetchAllPages(url) {
  let allData = [];
  let nextUrl = url;
  while (nextUrl) {
    const res = await fetch(nextUrl);
    const json = await res.json();
    if (!res.ok) throw new Error(extractErrorDetail(json));
    allData = allData.concat(json.data || []);
    // Meta's paging.next is a fully-formed URL (token and params already embedded).
    nextUrl = json.paging?.next || null;
  }
  return allData;
}

async function fetchMetaAdsData() {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const rawAccountId = process.env.META_AD_ACCOUNT_ID || "";
  const accountId = rawAccountId.replace(/^act_/, ""); // normalize whether or not "act_" was included

  const fields = [
    "date_start",
    "campaign_name",
    "adset_name",
    "ad_name",
    "objective",
    "spend",
    "reach",
    "impressions",
    "clicks",
    "unique_clicks",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const timeRange = JSON.stringify({
    since: `${new Date().getFullYear()}-01-01`,
    until: `${new Date().getFullYear()}-12-31`,
  });

  const params = new URLSearchParams({
    access_token: accessToken,
    level: "ad", // finest granularity — includes campaign_name/adset_name/ad_name per row
    fields,
    time_range: timeRange,
    time_increment: "1", // daily breakdown
    limit: "500",
  });

  const url = `https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights?${params.toString()}`;
  const rows = await fetchAllPages(url);

  const dailyAdLevel = rows.map((r) => ({
    Date: r.date_start, // "YYYY-MM-DD"
    Campaign: r.campaign_name || "",
    AdSet: r.adset_name || "",
    Ad: r.ad_name || "",
    Objective: r.objective || "", // confirm this actually populates at ad-level once tested — campaign objective is not always echoed on ad-level insights rows
    Cost: num(r.spend),
    Reach: num(r.reach),
    Impressions: num(r.impressions),
    Clicks: num(r.clicks),
    UniqueClicks: num(r.unique_clicks),
    MessagingConversationsStarted: extractAction(r.actions, NAMED_ACTION_TYPES.messagingConversationsStarted),
    Leads: extractAction(r.actions, NAMED_ACTION_TYPES.leads),
    // Full raw array — use this to identify the correct action_type for
    // "registration completed" (or anything else not yet named above) from
    // a real response, then add it to NAMED_ACTION_TYPES.
    actionsRaw: r.actions || [],
  }));

  return { dailyAdLevel, fetchedAt: new Date().toISOString(), apiVersion: API_VERSION };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const now = Date.now();
    const forceRefresh = req.query?.refresh === "1";
    if (!dataCache.data || forceRefresh || now - dataCache.fetchedAt > CACHE_TTL_MS) {
      dataCache = { data: await fetchMetaAdsData(), fetchedAt: now };
    }
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    return res.status(200).json(dataCache.data);
  } catch (err) {
    console.error("Meta Marketing API error:", err);
    return res.status(502).json({
      error: "No se pudo obtener datos de Meta Ads",
      detail: err.message || String(err),
    });
  }
}
