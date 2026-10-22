import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnPath } from "../src/utils/navigation.js";

test("keeps internal destinations and query/hash", () => {
  assert.equal(
    safeReturnPath({ pathname: "/lecturer/sections", search: "?page=2", hash: "#list" }, "/dashboard"),
    "/lecturer/sections?page=2#list",
  );
});

test("rejects protocol-relative, backslash and public auth destinations", () => {
  assert.equal(safeReturnPath({ pathname: "//evil.example" }, "/dashboard"), "/dashboard");
  assert.equal(safeReturnPath({ pathname: "/\\evil.example" }, "/dashboard"), "/dashboard");
  assert.equal(safeReturnPath({ pathname: "/login" }, "/dashboard"), "/dashboard");
  assert.equal(safeReturnPath(null, "/dashboard"), "/dashboard");
});
