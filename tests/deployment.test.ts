import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../app/api/test/sheets/route";

test("production disables the diagnostic Sheets endpoint before accessing credentials", async () => {
  const previous = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    const response = await GET();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: previous });
  }
});
