import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedCsv, getPool } from "../db/data-lake.js";
import { findConceptColumn } from "../agents/columnSynonyms.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = "/Users/batdorjsukhbaatar/meta_ads_insights_sample.csv";
const TABLE_NAME = "meta_ads_upload_test";
const TEST_OWNER = "upload_test_user";

const META_COLS = [
    "campaign_id", "campaign_name", "campaign_status", "objective",
    "adset_id", "adset_name", "ad_id", "ad_name",
    "date_start", "date_stop",
    "impressions", "reach", "frequency", "clicks",
    "ctr", "cpc", "spend", "cpm",
    "conversions", "cost_per_conversion", "purchase_roas",
];

describe("Meta Ads CSV — real PostgreSQL upload", () => {
    beforeAll(async () => {
        await seedCsv(CSV_PATH, TABLE_NAME, TEST_OWNER, "Meta Ads test upload", true);
    }, 30000);

    afterAll(async () => {
        const pool = getPool();
        if (pool) {
            await pool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}" CASCADE`).catch(() => {});
        }
    }, 10000);

    it("table was created with correct columns", async () => {
        const pool = getPool();
        const result = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
            [TABLE_NAME],
        );
        const dbCols = result.rows.map((r: any) => r.column_name);
        for (const col of META_COLS) {
            expect(dbCols, `column "${col}" should exist in DB`).toContain(col);
        }
    });

    it("data was inserted (24 rows)", async () => {
        const pool = getPool();
        const result = await pool.query(`SELECT COUNT(*) AS cnt FROM "${TABLE_NAME}"`);
        expect(Number(result.rows[0].cnt)).toBe(24);
    });

    it("date_start and date_stop are stored as TEXT (seedCsv infers text; detectDateColumn handles detection)", async () => {
        const pool = getPool();
        const result = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('date_start', 'date_stop')`,
            [TABLE_NAME],
        );
        for (const row of result.rows) {
            expect(row.data_type).toBe("text");
        }
    });

    it("numeric columns have correct types", async () => {
        const pool = getPool();
        const result = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('impressions', 'clicks', 'ctr', 'cpc', 'spend', 'cpm')`,
            [TABLE_NAME],
        );
        const typeMap: Record<string, string> = {};
        for (const row of result.rows) {
            typeMap[row.column_name] = row.data_type;
        }
        expect(typeMap["impressions"]).toMatch(/int|numeric/);
        expect(typeMap["clicks"]).toMatch(/int|numeric/);
        expect(typeMap["ctr"]).toMatch(/numeric|real|double/);
        expect(typeMap["cpc"]).toMatch(/numeric|real|double/);
        expect(typeMap["spend"]).toMatch(/numeric|real|double/);
        expect(typeMap["cpm"]).toMatch(/numeric|real|double/);
    });

    it("data_lake_catalog entry exists with all 21 columns", async () => {
        const pool = getPool();
        const result = await pool.query(
            `SELECT columns_info FROM data_lake_catalog WHERE table_name = $1`,
            [TABLE_NAME],
        );
        expect(result.rows.length).toBeGreaterThanOrEqual(1);
        const columnsInfo = JSON.parse(result.rows[0].columns_info);
        expect(columnsInfo.length).toBe(21);
        for (const col of META_COLS) {
            expect(columnsInfo).toContain(col);
        }
    });

    it("findConceptColumn — spend points to spend column", () => {
        expect(findConceptColumn(META_COLS, "spend")).toBe("spend");
    });

    it("findConceptColumn — impressions points to impressions", () => {
        expect(findConceptColumn(META_COLS, "impressions")).toBe("impressions");
    });

    it("findConceptColumn — reach also matches impressions concept", () => {
        const colsWithoutImp = META_COLS.filter(c => c !== "impressions");
        expect(findConceptColumn(colsWithoutImp, "impressions")).toBe("reach");
    });

    it("findConceptColumn — roas points to purchase_roas", () => {
        expect(findConceptColumn(META_COLS, "roas")).toBe("purchase_roas");
    });

    it("findConceptColumn — conversions points to conversions", () => {
        expect(findConceptColumn(META_COLS, "conversions")).toBe("conversions");
    });

    it("findConceptColumn — date points to date_start", () => {
        expect(findConceptColumn(META_COLS, "date")).toBe("date_start");
    });

    it("actual data values are correct — first row spend", async () => {
        const pool = getPool();
        const result = await pool.query(`SELECT spend FROM "${TABLE_NAME}" ORDER BY campaign_id, ad_id LIMIT 1`);
        expect(Number(result.rows[0].spend)).toBeCloseTo(523.45, 1);
    });

    it("actual data values — campaign names include 'Summer Sale'", async () => {
        const pool = getPool();
        const result = await pool.query(
            `SELECT DISTINCT campaign_name FROM "${TABLE_NAME}" ORDER BY campaign_name`,
        );
        const names = result.rows.map((r: any) => r.campaign_name);
        expect(names).toContain("Summer Sale 2025");
        expect(names).toContain("Brand Awareness Q2");
        expect(names).toContain("Lead Gen June");
        expect(names).toContain("Retargeting June");
    });
});
