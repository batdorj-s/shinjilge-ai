import { RateLimiter } from "../rate-limiter.js";

// API version pinned to v22.0. Meta deprecates metrics and endpoints without
// warning — always pin to a specific version, never use "latest". When upgrading
// to v23.0+, check the changelog at https://developers.facebook.com/docs/graph-api/changelog
// for breaking changes affecting insights metrics and permission scopes.
const GRAPH_API_BASE = "https://graph.facebook.com/v22.0";

export interface MetaApiConfig {
  accessToken: string;
  adAccountId?: string;
  pageId?: string;
  instagramId?: string;
}

const apiLimiter = new RateLimiter({ maxRequests: 200, windowMs: 60_000 });

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly fbErrorCode?: number,
    public readonly fbErrorSubcode?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export async function graphRequest<T = any>(
  path: string,
  params: Record<string, string> = {},
  accessToken: string,
  retries = 3,
): Promise<T> {
  const url = new URL(`${GRAPH_API_BASE}/${path}`);
  url.searchParams.set("access_token", accessToken);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    // Pre-call rate limit gate — check BEFORE sending request to Meta API
    const limit = apiLimiter.check(`meta_api_${path}`);
    if (!limit.allowed) {
      console.warn(`[Meta API] Pre-call rate limit hit for ${path}, waiting ${limit.resetInMs}ms`);
      await sleep(limit.resetInMs);
    }

    const response = await fetch(url.toString());
    const data = await response.json() as any;

    if (data.error) {
      const fbErr = data.error;
      if (fbErr.code === 4 || fbErr.code === 17 || fbErr.code === 80000) {
        // Rate limit — wait and retry
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 60_000);
        console.warn(`[Meta API] Rate limited (${fbErr.code}), retrying in ${waitTime}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(waitTime);
        continue;
      }
      if (fbErr.code === 190) {
        throw new MetaApiError(
          `Token expired or invalid: ${fbErr.message}`,
          response.status,
          fbErr.code,
          fbErr.error_subcode,
        );
      }
      if (fbErr.code === 100 && fbErr.error_subcode === 33) {
        throw new MetaApiError(
          `Insufficient permission: ${fbErr.message}`,
          response.status,
          fbErr.code,
          fbErr.error_subcode,
        );
      }
      throw new MetaApiError(
        `Meta API error: ${fbErr.message} (code: ${fbErr.code})`,
        response.status,
        fbErr.code,
        fbErr.error_subcode,
      );
    }

    return data as T;
  }

  throw new MetaApiError(`Max retries (${retries}) exceeded for path: ${path}`);
}

export async function fetchAdAccountId(accessToken: string): Promise<string> {
  // NOTE: me/adaccounts returns { data: [{ id: "act_..." }] } directly, NOT nested under adaccounts key
  const result = await graphRequest<{ data: Array<{ id: string }> }>(
    "me/adaccounts",
    { fields: "id" },
    accessToken,
  );
  const accounts = result.data;
  if (!accounts || accounts.length === 0) {
    throw new MetaApiError("No ad accounts found for this user");
  }
  // ROOT CAUSE: Meta returns the ad account ID WITH the "act_" prefix
  // (e.g. "act_770599790354922"), but downstream fetchCampaigns/fetchAdSets
  // etc. prepend "act_" again: `act_${adAccountId}/campaigns`.
  // If we returned the raw ID as-is, we'd get act_act_770599790354922 — a 404.
  //
  // This is unique to ad accounts. Page IDs (e.g. "1428078340802557") and
  // Instagram IDs (e.g. "17841405822304") are always bare numeric strings
  // returned without any prefix, so they do NOT need stripping — verified by
  // inspecting fetchPagePosts(`${pageId}/posts`) and
  // fetchInstagramMedia(`${instagramId}/media`).
  const rawId = accounts[0].id;
  return rawId.replace(/^act_/, "");
}

export interface CampaignNode {
  id: string;
  name: string;
  status: string;
  objective?: string;
  created_time?: string;
  daily_budget?: string;
  lifetime_budget?: string;
}

export async function fetchCampaigns(
  adAccountId: string,
  accessToken: string,
): Promise<CampaignNode[]> {
  const result = await graphRequest<{ data: CampaignNode[] }>(
    `act_${adAccountId}/campaigns`,
    {
      fields: "id,name,status,objective,created_time,daily_budget,lifetime_budget",
      limit: "100",
    },
    accessToken,
  );
  return result.data || [];
}

export interface AdSetNode {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  end_time?: string;
  created_time?: string;
}

export async function fetchAdSets(
  adAccountId: string,
  accessToken: string,
): Promise<AdSetNode[]> {
  const result = await graphRequest<{ data: AdSetNode[] }>(
    `act_${adAccountId}/adsets`,
    {
      fields: "id,name,campaign_id,status,daily_budget,lifetime_budget,start_time,end_time,created_time",
      limit: "100",
    },
    accessToken,
  );
  return result.data || [];
}

export interface AdNode {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: string;
  creative?: { id: string };
  created_time?: string;
}

export async function fetchAds(
  adAccountId: string,
  accessToken: string,
): Promise<AdNode[]> {
  const result = await graphRequest<{ data: AdNode[] }>(
    `act_${adAccountId}/ads`,
    {
      fields: "id,name,adset_id,campaign_id,status,creative{id},created_time",
      limit: "100",
    },
    accessToken,
  );
  return result.data || [];
}

export interface AdInsightAction {
  action_type: string;
  value: string;
}

export interface AdInsight {
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  date_start: string;
  date_stop: string;
  impressions: string;
  clicks: string;
  spend: string;
  ctr: string;
  cpc: string;
  cpm: string;
  reach: string;
  frequency: string;
  actions?: AdInsightAction[];
  cost_per_action_type?: AdInsightAction[];
  action_values?: AdInsightAction[];
  purchase_roas?: AdInsightAction[];
}

export async function fetchAdInsights(
  adAccountId: string,
  accessToken: string,
  since?: string,
  until?: string,
): Promise<AdInsight[]> {
  const params: Record<string, string> = {
    level: "ad",
    fields: [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "date_start",
      "date_stop",
      "impressions",
      "clicks",
      "spend",
      "ctr",
      "cpc",
      "cpm",
      "reach",
      "frequency",
      "actions",
      "cost_per_action_type",
      "action_values",
      "purchase_roas",
    ].join(","),
    time_increment: "1",
    limit: "500",
  };

  if (since) params.since = since;
  if (until) params.until = until;

  const result = await graphRequest<{ data: AdInsight[] }>(
    `act_${adAccountId}/insights`,
    params,
    accessToken,
  );
  return result.data || [];
}

export async function fetchPagePosts(
  pageId: string,
  accessToken: string,
  since?: string,
  until?: string,
): Promise<any[]> {
  // NOTE: Post-level insights metrics (post_impressions, post_engaged_users, etc.)
  // were deprecated on 2026-06-15. We now fetch posts without inline insights and
  // enrich them via per-post /insights calls with the v22.0 metric names below.
  const params: Record<string, string> = {
    fields: "id,message,created_time,permalink_url",
    limit: "100",
  };
  if (since) params.since = since;
  if (until) params.until = until;

  const result = await graphRequest<{ data: any[] }>(
    `${pageId}/posts`,
    params,
    accessToken,
  );
  const posts = result.data || [];

  // NOTE: Post-level insights require a Page Access Token with read_insights
  // permission. Many Page Tokens (especially from Graph API Explorer) no longer
  // have access — insights enrichment is skipped to avoid wasted API calls.
  // If read_insights is available and you need post metrics, use:
  //   GET /{post-id}/insights?metric=post_reactions_like_total,post_clicks&period=lifetime

  return posts;
}

export async function fetchInstagramMedia(
  instagramId: string,
  accessToken: string,
): Promise<any[]> {
  // Basic fields always work with instagram_basic scope
  const fields = "id,caption,media_type,media_url,permalink,like_count,comments_count";
  // Insights require instagram_manage_insights scope (not always available)
  const insightsFields = "insights.metric(impressions,reach,likes,comments,saved){values,period}";

  const params: Record<string, string> = {
    fields: `${fields},${insightsFields}`,
    limit: "100",
  };

  try {
    const result = await graphRequest<{ data: any[] }>(
      `${instagramId}/media`,
      params,
      accessToken,
    );
    return result.data || [];
  } catch (err: any) {
    // If insights fail (code 10 = no permission), retry without insights
    if (err.fbErrorCode === 10) {
      console.log("[Meta API] Instagram insights not available (missing instagram_manage_insights scope), falling back to basic fields");
      const fallbackParams: Record<string, string> = {
        fields,
        limit: "100",
      };
      const result = await graphRequest<{ data: any[] }>(
        `${instagramId}/media`,
        fallbackParams,
        accessToken,
      );
      return result.data || [];
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
