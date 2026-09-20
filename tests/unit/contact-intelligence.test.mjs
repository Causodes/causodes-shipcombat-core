import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  settings: { get: () => "numeric" },
};
globalThis.CONST = {
  TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 },
};

const { getContactDesignation } = await import("../../scripts/targeting/contact-intelligence.js");

test("a live contact keeps its scene ordinal when a historical lock record exists", () => {
  const data = {
    resources: {
      sensors: {
        contacts: { target: { ordinal: 20, confirmed: true } },
        locks: [{ targetTokenId: "target", tier: 1 }],
      },
    },
  };

  assert.equal(getContactDesignation(data, "target", {
    currentTier: 1,
    fallbackOrdinal: 1,
    disposition: -1,
  }), "Contact-1");
  assert.equal(getContactDesignation(data, "target", {
    currentTier: 1,
    disposition: -1,
  }), "Contact-20");
});
