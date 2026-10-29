import assert from "node:assert/strict";
import { isAppOrigin } from "../desktop/origin.mjs";

assert.equal(new URL("cardano-sparrow://app/").origin, "null");
for (const value of ["cardano-sparrow://app", "cardano-sparrow://app/", "cardano-sparrow://app/index.html"])
  assert.equal(isAppOrigin(value), true, value);
for (const value of ["null", "https://app/", "cardano-sparrow://evil/", "cardano-sparrow://app.evil/", "cardano-sparrow://user@app/", "cardano-sparrow://app:1234/", "not a URL"])
  assert.equal(isAppOrigin(value), false, value);
console.log("Custom-protocol origin checks passed.");
