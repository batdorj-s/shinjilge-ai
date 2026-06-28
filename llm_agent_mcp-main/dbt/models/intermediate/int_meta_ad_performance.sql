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
    (spend / nullif(clicks, 0)) as cost_per_click,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(actions) as elem where elem->>'action_type' = 'purchase' limit 1), 0) as conversions,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(actions) as elem where elem->>'action_type' = 'lead' limit 1), 0) as leads,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(actions) as elem where elem->>'action_type' = 'add_to_cart' limit 1), 0) as add_to_cart,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(actions) as elem where elem->>'action_type' = 'view_content' limit 1), 0) as view_content,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(cost_per_action_type) as elem where elem->>'action_type' = 'purchase' limit 1), 0) as cost_per_conversion,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(purchase_roas) as elem where elem->>'action_type' = 'purchase' limit 1), 0) as purchase_roas,
    coalesce((select (elem->>'value')::numeric from jsonb_array_elements(action_values) as elem where elem->>'action_type' = 'purchase' limit 1), 0) as conversion_value
from staged
