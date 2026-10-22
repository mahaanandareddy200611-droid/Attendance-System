import assert from "node:assert/strict";
import test from "node:test";
import { createCsv, escapeCsvCell } from "../src/utils/csv.js";

test("CSV quotes commas, double quotes and line breaks", () => {
  assert.equal(escapeCsvCell('A, "B"\nC'), '"A, ""B""\nC"');
});

test("CSV neutralizes spreadsheet formulas after leading whitespace", () => {
  assert.equal(escapeCsvCell('=HYPERLINK("https://example.test")'), '"\'=HYPERLINK(""https://example.test"")"');
  assert.equal(escapeCsvCell("\t@SUM(A1:A2)"), '"\'\t@SUM(A1:A2)"');
  assert.equal(escapeCsvCell("-1+2"), '"\'-1+2"');
});

test("CSV keeps null values empty and includes UTF-8 BOM and CRLF rows", () => {
  const output = createCsv(["Name", "Value"], [["Ada", null], ["Grace", "line 1\nline 2"]]);
  assert.ok(output.startsWith("\uFEFF"));
  assert.ok(output.includes('"Ada",""\r\n'));
  assert.ok(output.endsWith('"Grace","line 1\nline 2"'));
});

test("CSV validates input shape", () => {
  assert.throws(() => createCsv("not headers", []), TypeError);
  assert.throws(() => createCsv(["A"], [null]), TypeError);
});
