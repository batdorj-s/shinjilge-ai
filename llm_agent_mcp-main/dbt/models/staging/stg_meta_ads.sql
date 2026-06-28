{{
  config(
    materialized='incremental',
    unique_key='insight_id',
    on_schema_change='append_new_columns',
  )
}}

{% set insights_table = var('meta_insights_table', 'meta_bronze_insights') %}
{% set campaigns_table = var('meta_campaigns_table', 'meta_bronze_campaigns') %}
{% set ads_table = var('meta_ads_table', 'meta_bronze_ads') %}

with insights as (
    select * from {{ insights_table }}
    {% if is_incremental() %}
        where fetched_at > (select max(fetched_at) from {{ this }})
    {% endif %}
),
campaigns as (
    select * from {{ campaigns_table }}
),
ads as (
    select * from {{ ads_table }}
)

select
    i.id as insight_id,
    i.campaign_id,
    i.campaign_name,
    i.adset_id,
    i.adset_name,
    i.ad_id,
    i.ad_name,
    i.date_start,
    i.date_stop,
    i.impressions,
    i.clicks,
    i.spend,
    i.ctr,
    i.cpc,
    i.cpm,
    i.reach,
    i.frequency,
    i.actions,
    i.cost_per_action_type,
    i.action_values,
    i.purchase_roas,
    coalesce(c.status, 'UNKNOWN') as campaign_status,
    c.objective,
    coalesce(a.status, 'UNKNOWN') as ad_status,
    i.owner_id
from insights i
left join campaigns c on i.campaign_id = c.id
left join ads a on i.ad_id = a.id
