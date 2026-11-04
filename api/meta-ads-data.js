// /api/meta-ads-data.js
//
// Vercel Serverless Function — the ONLY piece of this project allowed to hold
// the Meta access token. Never move this logic into the dashboard's client-side
// JS: anything shipped to the browser is public.
//
// Auth: System User access token (Business Manager > System Users). Does not
// expire and needs no refresh flow.
//
// ---------------------------------------------------------------------------
// Query params (all optional):
//   ?since=YYYY-MM-DD&until=YYYY-MM-DD   custom range (default: DATA_START_DATE → today)
//   ?debug=objectives                    diagnostic summary instead of rows:
//                                        campaign → Meta objective → ObjetivoOVEX → spend,
//                                        plus totals per action_type. Use it to verify
//                                        that every campaign is classified correctly.
//   ?refresh=<REFRESH_SECRET>            bypass the cache (only if REFRESH_SECRET is set)
//
// Environment variables:
//   META_ACCESS_TOKEN        (required) System User token
//   META_AD_ACCOUNT_ID       (required) with or without "act_"
//   META_API_VERSION         default v26.0 — Marketing API deprecates on a ~90-day clock
//   DATA_START_DATE          default 2026-01-01 — first day the dashboard needs
//   REPORT_TIMEZONE          default America/Mexico_City — defines "today"
//   ALLOWED_ORIGIN           optional; only needed if something OTHER than the
//                            dashboard (same origin) must call this endpoint
//   REFRESH_SECRET           optional; enables ?refresh=<secret>
//   META_MAX_PARALLEL        default 8 — concurrent monthly requests
//   WEBFORMS_OBJECTIVES      default OUTCOME_LEADS,LEAD_GENERATION,OUTCOME_SALES,CONVERSIONS
//   APP_OBJECTIVES           default OUTCOME_APP_PROMOTION,APP_INSTALLS
// ---------------------------------------------------------------------------

const API_VERSION = process.env.META_API_VERSION || "v26.0";
const DATA_START_DATE = process.env.DATA_START_DATE || "2026-01-01";
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "America/Mexico_City";
const MAX_PARALLEL = Math.max(1, parseInt(process.env.META_MAX_PARALLEL || "8", 10));
const MAX_RANGE_DAYS = 3 * 366; // hard ceiling so a hand-crafted URL can't request a decade

// Hobby plans are hard-capped at 10s regardless of this; Pro honors it.
export const config = { maxDuration: 60 };

// ---------------------------------------------------------------------------
// Objective classification — single source of truth for OVEX's own taxonomy
// (WEBFORMS / MENSAJES / APP / OTRO). The dashboard reads `ObjetivoOVEX`
// directly instead of re-deriving it from Meta's raw enum.
// Priority: campaign name containing "mensaje" wins (same rule the Sheet used),
// then Meta's objective enum. Lists are env-overridable so a newly discovered
// objective is a config change, not a code change. Verify with ?debug=objectives.
// ---------------------------------------------------------------------------
const csvSet = (v, fallback) =>
  new Set((v || fallback).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const WEBFORMS_OBJECTIVES = csvSet(process.env.WEBFORMS_OBJECTIVES, "OUTCOME_LEADS,LEAD_GENERATION,OUTCOME_SALES,CONVERSIONS");
const APP_OBJECTIVES = csvSet(process.env.APP_OBJECTIVES, "OUTCOME_APP_PROMOTION,APP_INSTALLS");

function classifyObjetivoOVEX(campaignName, objective) {
  const name = (campaignName || "").toLowerCase();
  const obj = (objective || "").toUpperCase();
  if (name.includes("mensaje") || obj === "MESSAGES") return "MENSAJES";
  if (APP_OBJECTIVES.has(obj)) return "APP";
  if (WEBFORMS_OBJECTIVES.has(obj)) return "WEBFORMS";
  return "OTRO";
}

// action_type strings. registrationsCompleted = complete_registration was
// confirmed against this account's real data; the others are Meta-documented.
const NAMED_ACTION_TYPES = {
  messagingConversationsStarted: "onsite_conversion.messaging_conversation_started_7d",
  leads: "lead",
  registrationsCompleted: "complete_registration",
};

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayInTimezone(tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function isValidIsoDate(s) {
  if (!ISO_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const isoToUtc = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const utcToIso = (d) => d.toISOString().slice(0, 10);

// Resolves ?since/?until into a validated range. Default: DATA_START_DATE → today.
// This is what keeps 2026 available after the calendar flips to 2027 — the
// old code asked for "the current year" only.
function resolveRange(query) {
  const today = todayInTimezone(REPORT_TIMEZONE);
  const since = query?.since ?? DATA_START_DATE;
  let until = query?.until ?? today;
  if (!isValidIsoDate(since) || !isValidIsoDate(until)) {
    throw httpError(400, "Parámetros since/until inválidos — usa el formato YYYY-MM-DD.");
  }
  if (until > today) until = today; // never ask for the future
  if (since > until) throw httpError(400, `Rango vacío: since (${since}) es posterior a until (${until}).`);
  const days = Math.round((isoToUtc(until) - isoToUtc(since)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw httpError(400, `Rango demasiado largo (${days} días, máximo ${MAX_RANGE_DAYS}).`);
  return { since, until };
}

// Split [since, until] into calendar-month chunks (possibly spanning years).
// Meta's Insights API answers a month of daily ad-level data far faster than
// a full year in one call — that's what fixed the original timeout.
function monthChunks({ since, until }) {
  const chunks = [];
  let cursor = isoToUtc(since);
  const end = isoToUtc(until);
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push({ since: utcToIso(cursor), until: utcToIso(chunkEnd) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return chunks;
}

// Run async tasks with a concurrency ceiling. Once the range spans two years
// (~24 months), firing everything at once risks Meta rate limits.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Meta API calls
// ---------------------------------------------------------------------------
const num = (v) => (v === undefined || v === null ? 0 : parseFloat(v));
const round2 = (v) => Math.round(v * 100) / 100;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function extractAction(actionsArray, actionType) {
  if (!Array.isArray(actionsArray)) return 0;
  const match = actionsArray.find((a) => a.action_type === actionType);
  return match ? num(match.value) : 0;
}

function extractErrorDetail(json) {
  const err = json?.error;
  if (!err) return "Error desconocido de Meta Marketing API";
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
    nextUrl = json.paging?.next || null; // fully-formed URL, token already embedded
  }
  return allData;
}

// Only the fields the dashboard actually uses (+ a few cheap awareness metrics).
// Removed vs. the previous version: cost_per_action_type (never read) and the
// raw actions array in the response (heavy; registration type is confirmed).
const INSIGHT_FIELDS = [
  "date_start", "campaign_name", "adset_name", "ad_name", "objective",
  "spend", "reach", "impressions", "clicks", "unique_clicks", "actions",
].join(",");

async function fetchInsightsForRange(accessToken, accountId, range) {
  const params = new URLSearchParams({
    access_token: accessToken,
    level: "ad",
    fields: INSIGHT_FIELDS,
    time_range: JSON.stringify(range),
    time_increment: "1",
    limit: "500",
  });
  return fetchAllPages(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights?${params.toString()}`);
}

async function fetchRawRows(range) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const accountId = (process.env.META_AD_ACCOUNT_ID || "").replace(/^act_/, "");
  if (!accessToken || !accountId) throw new Error("Faltan META_ACCESS_TOKEN o META_AD_ACCOUNT_ID en Vercel.");
  // Any failed month fails the whole response on purpose: partial spend
  // presented as complete is worse than a visible error (the dashboard then
  // falls back to the Sheet and shows the ⚠️ badge).
  const perMonth = await mapWithConcurrency(monthChunks(range), MAX_PARALLEL,
    (chunk) => fetchInsightsForRange(accessToken, accountId, chunk));
  return perMonth.flat();
}

function shapeRows(rows) {
  return rows.map((r) => ({
    Date: r.date_start,
    Campaign: r.campaign_name || "",
    AdSet: r.adset_name || "",
    Ad: r.ad_name || "",
    Objective: r.objective || "",                    // Meta's raw enum (kept for auditing)
    ObjetivoOVEX: classifyObjetivoOVEX(r.campaign_name, r.objective), // what the dashboard filters on
    Cost: round2(num(r.spend)),
    Reach: num(r.reach),
    Impressions: num(r.impressions),
    Clicks: num(r.clicks),
    UniqueClicks: num(r.unique_clicks),
    MessagingConversationsStarted: extractAction(r.actions, NAMED_ACTION_TYPES.messagingConversationsStarted),
    Leads: extractAction(r.actions, NAMED_ACTION_TYPES.leads),
    RegistrationsCompleted: extractAction(r.actions, NAMED_ACTION_TYPES.registrationsCompleted),
  }));
}

// ?debug=objectives — compact verification view instead of thousands of rows.
function buildObjectiveSummary(rows, range) {
  const campaigns = {};
  const actionTotals = {};
  let totalSpend = 0;
  rows.forEach((r) => {
    const key = r.campaign_name || "(sin nombre)";
    if (!campaigns[key]) {
      campaigns[key] = { campaign: key, metaObjective: r.objective || "", objetivoOVEX: classifyObjetivoOVEX(r.campaign_name, r.objective), spend: 0, registrationsCompleted: 0, messagingConversationsStarted: 0 };
    }
    const c = campaigns[key];
    const spend = num(r.spend);
    c.spend += spend; totalSpend += spend;
    c.registrationsCompleted += extractAction(r.actions, NAMED_ACTION_TYPES.registrationsCompleted);
    c.messagingConversationsStarted += extractAction(r.actions, NAMED_ACTION_TYPES.messagingConversationsStarted);
    (r.actions || []).forEach((a) => { actionTotals[a.action_type] = (actionTotals[a.action_type] || 0) + num(a.value); });
  });
  const list = Object.values(campaigns).map((c) => ({ ...c, spend: round2(c.spend) })).sort((a, b) => b.spend - a.spend);
  const spendByObjetivoOVEX = {};
  list.forEach((c) => { spendByObjetivoOVEX[c.objetivoOVEX] = round2((spendByObjetivoOVEX[c.objetivoOVEX] || 0) + c.spend); });
  return { range, totalSpend: round2(totalSpend), spendByObjetivoOVEX, campaigns: list, actionTypeTotals: actionTotals, apiVersion: API_VERSION };
}

// ---------------------------------------------------------------------------
// Cache: per-range, in-memory, 15 min. Resets on cold starts.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const cache = new Map(); // key -> { data, fetchedAt }

function cacheGet(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS ? hit.data : null;
}
function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(key, { data, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // The dashboard calls this same-origin, so no CORS header is needed for it.
  // Only emit one when ALLOWED_ORIGIN is explicitly configured.
  if (process.env.ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const range = resolveRange(req.query);
    const debug = req.query?.debug === "objectives";
    const secret = process.env.REFRESH_SECRET;
    const forceRefresh = Boolean(secret) && req.query?.refresh === secret;
    const cacheKey = `${debug ? "debug" : "rows"}|${range.since}|${range.until}`;

    let data = forceRefresh ? null : cacheGet(cacheKey);
    if (!data) {
      const raw = await fetchRawRows(range);
      data = debug
        ? buildObjectiveSummary(raw, range)
        : { dailyAdLevel: shapeRows(raw), range, fetchedAt: new Date().toISOString(), apiVersion: API_VERSION };
      cacheSet(cacheKey, data);
    }
    // Edge cache for normal dashboard loads (keyed by full URL, so each range
    // caches separately); never for debug or a forced refresh.
    res.setHeader("Cache-Control", debug || forceRefresh ? "no-store" : "s-maxage=900, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Meta Marketing API error:", err);
    return res.status(err.status || 502).json({
      error: err.status === 400 ? "Solicitud inválida" : "No se pudo obtener datos de Meta Ads",
      detail: err.message || String(err),
    });
  }
}
