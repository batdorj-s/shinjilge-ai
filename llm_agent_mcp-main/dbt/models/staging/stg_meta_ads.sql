{{
  config(
    enabled=false,
    materialized='incremental',
    unique_key='insight_id',
    on_schema_change='append_new_columns',
  )
}}

-- DISABLED: meta_bronze_insights table removed (insights deprecated by Meta 2026-06-15).
-- The downstream models int_meta_ad_performance, meta_adset_kpi, and meta_campaign_kpi
-- are also skipped automatically via dbt's ref() chain.

select null as insight_id limit 0
