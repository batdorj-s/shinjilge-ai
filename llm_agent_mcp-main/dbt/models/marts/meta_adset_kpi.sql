{{
  config(
    materialized='incremental',
    unique_key='adset_id',
    on_schema_change='append_new_columns',
  )
}}

with performance as (
    select * from {{ ref('int_meta_ad_performance') }}
    {% if is_incremental() %}
        where date_start > (select max(last_impression_date) from {{ this }})
    {% endif %}
)

select
    adset_id,
    adset_name,
    campaign_id,
    campaign_name,
    min(date_start) as first_impression_date,
    max(date_stop) as last_impression_date,
    sum(impressions) as total_impressions,
    sum(clicks) as total_clicks,
    sum(spend) as total_spend,
    round(avg(calculated_ctr), 2) as avg_ctr,
    round(avg(calculated_cpc), 2) as avg_cpc,
    round(avg(calculated_cpm), 2) as avg_cpm,
    sum(reach) as total_reach,
    round(avg(frequency), 2) as avg_frequency,
    count(distinct ad_id) as unique_ads,
    owner_id
from performance
group by adset_id, adset_name, campaign_id, campaign_name, owner_id
