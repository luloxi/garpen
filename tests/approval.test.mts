import test from "node:test";
import assert from "node:assert/strict";
import { isAutoApproved } from "../lib/approval.ts";

test("admin, lulox.eth and kathonejo are approved on first sign-in; everyone else stays pending", () => {
  for (const e of ["lucianoolivabianco@gmail.com", "lulox.eth@gmail.com", " Kathonejo@Gmail.com "]) assert.equal(isAutoApproved(e, "lucianoolivabianco@gmail.com"), true, e);
  for (const e of ["someone@gmail.com", "lulox.eth@gmail.com.evil.com", "xlulox.eth@gmail.com"]) assert.equal(isAutoApproved(e, "lucianoolivabianco@gmail.com"), false, e);
});
