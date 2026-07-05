// Regression test for the production/PGlite jsonb parity fix (surfaced by the M1.8
// runtime smoke): under Bun, postgres.js returns json/jsonb columns as raw JSON
// TEXT, so the client seam must JSON.parse them itself by column type OID. This
// proves applyJsonColumnParsers replicates that parser exactly — parse jsonb/json,
// leave text and already-parsed values untouched — so the live app behaves like
// the PGlite-backed test gate (where the 500 in the public theme render came from
// an unparsed `"#10b981"` accent string).

import { expect, test } from "bun:test";
import { applyJsonColumnParsers, type PgResult } from "../client";

function result(
  columns: Array<{ name: string; type: number }>,
  rows: Array<Record<string, unknown>>,
): PgResult {
  const r = rows as PgResult;
  r.columns = columns;
  return r;
}

const TEXT = 25;
const JSON_OID = 114;
const JSONB = 3802;

test("jsonb/json string columns are JSON.parsed; text columns are not", () => {
  const out = applyJsonColumnParsers(
    result(
      [
        { name: "title", type: TEXT },
        { name: "accent", type: JSONB }, // the exact bug: a jsonb string value
        { name: "tags", type: JSON_OID }, // json_agg result column
        { name: "enabled", type: JSONB },
        { name: "complete", type: JSONB },
      ],
      [
        {
          title: "Brandon's Site", // plain text — must stay a string
          accent: '"#10b981"', // jsonb string text → "#10b981"
          tags: '[{"slug":"news"}]', // json array text → array
          enabled: '["blog"]', // jsonb array text → array
          complete: "true", // jsonb bool text → boolean
        },
      ],
    ),
  );

  expect(out[0].title).toBe("Brandon's Site");
  expect(out[0].accent).toBe("#10b981"); // the fix: quotes stripped, parseable hex
  expect(out[0].tags).toEqual([{ slug: "news" }]);
  expect(out[0].enabled).toEqual(["blog"]);
  expect(out[0].complete).toBe(true);
});

test("already-parsed (non-string) jsonb values are left untouched (PGlite path)", () => {
  const out = applyJsonColumnParsers(
    result(
      [{ name: "v", type: JSONB }],
      [{ v: ["already", "parsed"] }, { v: null }],
    ),
  );
  expect(out[0].v).toEqual(["already", "parsed"]);
  expect(out[1].v).toBeNull();
});

test("a result without column metadata is returned unchanged", () => {
  const rows = [{ a: "x" }] as PgResult;
  expect(applyJsonColumnParsers(rows)).toBe(rows);
  expect(rows[0].a).toBe("x");
});
