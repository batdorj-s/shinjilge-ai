import { RateLimiter } from "../rate-limiter.js";

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
  const me = await graphRequest<{ adaccounts?: { data: Array<{ id: string }> } }>(
    "me/adaccounts",
    { fields: "id" },
    accessToken,
  );
  const accounts = me.adaccounts?.data;
  if (!accounts || accounts.length === 0) {
    throw new MetaApiError("No ad accounts found for this user");
  }
  return accounts[0].id;
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
  actions?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
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
  const params: Record<string, string> = {
    fields: "id,message,created_time,permalink_url,insights.metric(post_impressions,post_engaged_users,post_reactions_by_type_total,post_comments,post_shares){values,period}",
    limit: "100",
  };
  if (since) params.since = since;
  if (until) params.until = until;

  const result = await graphRequest<{ data: any[] }>(
    `${pageId}/posts`,
    params,
    accessToken,
  );
  return result.data || [];
}

export async function fetchInstagramMedia(
  instagramId: string,
  accessToken: string,
): Promise<any[]> {
  const params: Record<string, string> = {
    fields: "id,caption,media_type,media_url,permalink,like_count,comments_count,insights.metric(impressions,reach,likes,comments,saved){values,period}",
    limit: "100",
  };

  const result = await graphRequest<{ data: any[] }>(
    `${instagramId}/media`,
    params,
    accessToken,
  );
  return result.data || [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
