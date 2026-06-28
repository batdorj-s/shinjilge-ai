import { describe, it, expect } from "vitest";
import { buildSemanticGroups } from "../utils.js";
import { findConceptColumn } from "../agents/columnSynonyms.js";
import { detectDateColumn } from "../agents/dateColumnHelper.js";

const META_COLS = [
    "campaign_id", "campaign_name", "campaign_status", "objective",
    "adset_id", "adset_name", "ad_id", "ad_name",
    "date_start", "date_stop",
    "impressions", "reach", "frequency", "clicks",
    "ctr", "cpc", "spend", "cpm",
    "conversions", "cost_per_conversion", "purchase_roas",
];

describe("Meta Ads CSV upload simulation", () => {
    it("buildSemanticGroups assigns date_start/date_stop to Date/Time", () => {
        const groups = buildSemanticGroups(META_COLS);
        const dateGroup = groups["Date/Time"];
        expect(dateGroup).toBeDefined();
        expect(dateGroup).toContain("date_start");
        expect(dateGroup).toContain("date_stop");
    });

    it("buildSemanticGroups assigns _id columns to ID group", () => {
        const groups = buildSemanticGroups(META_COLS);
        const idGroup = groups["ID"];
        expect(idGroup).toBeDefined();
        expect(idGroup).toContain("campaign_id");
        expect(idGroup).toContain("adset_id");
        expect(idGroup).toContain("ad_id");
    });

    it("buildSemanticGroups assigns campaign_status to Categorical", () => {
        const groups = buildSemanticGroups(META_COLS);
        const catGroup = groups["Categorical"];
        expect(catGroup).toBeDefined();
        expect(catGroup).toContain("campaign_status");
    });

    it("buildSemanticGroups assigns marketing metrics to Other", () => {
        const groups = buildSemanticGroups(META_COLS);
        const otherGroup = groups["Other"];
        expect(otherGroup).toBeDefined();
        expect(otherGroup).toContain("impressions");
        expect(otherGroup).toContain("clicks");
        expect(otherGroup).toContain("spend");
        expect(otherGroup).toContain("ctr");
        expect(otherGroup).toContain("cpc");
        expect(otherGroup).toContain("cpm");
        expect(otherGroup).toContain("reach");
        expect(otherGroup).toContain("frequency");
        expect(otherGroup).toContain("conversions");
        expect(otherGroup).toContain("cost_per_conversion");
        expect(otherGroup).toContain("purchase_roas");
        expect(otherGroup).toContain("campaign_name");
        expect(otherGroup).toContain("adset_name");
        expect(otherGroup).toContain("ad_name");
        expect(otherGroup).toContain("objective");
    });

    it("detectDateColumn finds date_start as native DATE type", () => {
        // Simulating a real PostgreSQL column type
        const result = detectDateColumn("date_start", "date");
        expect(result).not.toBeNull();
        expect(result!.detectedAs).toBe("native");
        expect(result!.sqlCast).toBe('CAST("date_start" AS DATE)');
    });

    it("detectDateColumn finds date_stop as native DATE type", () => {
        const result = detectDateColumn("date_stop", "date");
        expect(result).not.toBeNull();
        expect(result!.detectedAs).toBe("native");
    });

    it("detectDateColumn rejects time_zone even with name heuristic fallback", () => {
        const result = detectDateColumn("time_zone", "text", {
            sampleValues: ["Asia/Ulaanbaatar", "America/New_York"],
        });
        expect(result).toBeNull();
    });

    it("findConceptColumn maps all marketing concepts to correct columns", () => {
        const checks: Array<{ concept: string; expected: string }> = [
            { concept: "date", expected: "date_start" },
            { concept: "spend", expected: "spend" },
            { concept: "impressions", expected: "impressions" },
            { concept: "clicks", expected: "clicks" },
            { concept: "ctr", expected: "ctr" },
            { concept: "cpc", expected: "cpc" },
            { concept: "cpm", expected: "cpm" },
            { concept: "frequency", expected: "frequency" },
            { concept: "conversions", expected: "conversions" },
            { concept: "roas", expected: "purchase_roas" },
        ];
        for (const { concept, expected } of checks) {
            const col = findConceptColumn(META_COLS, concept);
            expect(col, `concept "${concept}" should be "${expected}"`).toBe(expected);
        }
    });

    it("no cross-concept collision between spend/sales/income", () => {
        const cols = ["id", "spend", "sales_amount", "gross_income"];
        expect(findConceptColumn(cols, "spend")).toBe("spend");
        expect(findConceptColumn(cols, "sales")).toBe("sales_amount");
        expect(findConceptColumn(cols, "income")).toBe("gross_income");
    });

    it("conversions does not collide with impressions or spend", () => {
        const cols = ["conversions", "impressions", "spend"];
        expect(findConceptColumn(cols, "conversions")).toBe("conversions");
        expect(findConceptColumn(cols, "impressions")).toBe("impressions");
        expect(findConceptColumn(cols, "spend")).toBe("spend");
    });

    it("purchase_roas matches roas concept, not sales", () => {
        const cols = ["purchase_roas", "total_sales"];
        expect(findConceptColumn(cols, "roas")).toBe("purchase_roas");
        expect(findConceptColumn(cols, "sales")).toBe("total_sales");
        expect(findConceptColumn(cols, "roas")).not.toBe(findConceptColumn(cols, "sales"));
    });

    it("date_start sample ISO values → text-iso detection", () => {
        const result = detectDateColumn("date_start", "text", {
            sampleValues: ["2025-06-01", "2025-06-02"],
        });
        expect(result).not.toBeNull();
        expect(result!.detectedAs).toBe("text-iso");
    });

    it("date_stop sample ISO values → text-iso detection", () => {
        const result = detectDateColumn("date_stop", "text", {
            sampleValues: ["2025-06-01", "2025-06-02"],
        });
        expect(result).not.toBeNull();
        expect(result!.detectedAs).toBe("text-iso");
    });
});
