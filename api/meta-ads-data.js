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

// Extends this function's allowed execution time on Vercel plans that support
// it (Hobby is hard-capped at 10s regardless of this setting — if you're on
// Hobby and this keeps timing out even with the monthly-chunking below,
// that's the ceiling to know about). Harmless to set even if your plan ignores it.
export const config = { maxDuration: 60 };


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
  // Best-guess default — verify against Meta Ads Manager's own "Completed
  // registration" column for a known campaign/date before trusting this in
  // reporting. Real accounts often surface several registration-adjacent
  // action_types (complete_registration, offsite_conversion.fb_pixel_complete_registration,
  // omni_complete_registration, ...add_meta_leads) with DIFFERENT values —
  // swap the string below if it turns out not to match.
  registrationsCompleted: "complete_registration",
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

// A full year of daily, ad-level data in ONE request is what was pushing this
// past Vercel's function execution limit on a cold cache. Meta's Insights API
// responds much faster to a narrower time_range, so split the year into
// monthly chunks and fetch them CONCURRENTLY — total wall-clock time ends up
// close to the slowest single month instead of the sum of all twelve.
function monthRangesUpTo(year, today) {
  const ranges = [];
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(year, m, 1));
    if (start > today) break; // skip months that haven't started yet
    const end = new Date(Date.UTC(year, m + 1, 0)); // last day of the month
    const fmt = (d) => d.toISOString().slice(0, 10);
    ranges.push({ since: fmt(start), until: fmt(end) });
  }
  return ranges;
}

async function fetchInsightsForRange(accessToken, accountId, fields, range) {
  const params = new URLSearchParams({
    access_token: accessToken,
    level: "ad", // finest granularity — includes campaign_name/adset_name/ad_name per row
    fields,
    time_range: JSON.stringify(range),
    time_increment: "1", // daily breakdown
    limit: "500",
  });
  const url = `https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights?${params.toString()}`;
  return fetchAllPages(url);
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

  const ranges = monthRangesUpTo(new Date().getFullYear(), new Date());
  const monthlyResults = await Promise.all(
    ranges.map((r) => fetchInsightsForRange(accessToken, accountId, fields, r))
  );
  const rows = monthlyResults.flat();

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
    RegistrationsCompleted: extractAction(r.actions, NAMED_ACTION_TYPES.registrationsCompleted),
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
