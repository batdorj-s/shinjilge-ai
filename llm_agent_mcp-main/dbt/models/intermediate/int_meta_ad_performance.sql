{{ config(materialized='ephemeral') }}

with staged as (
    select * from {{ ref('stg_meta_ads') }}
)

select
    *,
    case when impressions > 0
        then round(clicks::numeric / impressions * 100, 2)
        else 0
    end as calculated_ctr,
    case when clicks > 0
        then round(spend / clicks, 2)
        else 0
    end as calculated_cpc,
    case when impressions > 0
        then round(spend / impressions * 1000, 2)
        else 0
    end as calculated_cpm,
    (spend / nullif(clicks, 0)) as cost_per_click
from staged
