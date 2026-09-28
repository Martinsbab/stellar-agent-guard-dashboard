import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_FILTER,
  TAB_PATHNAMES,
  URL_FILTERS,
  URL_NETWORKS,
  URL_TABS,
  decodeUrlState,
  encodeUrlState,
  isValidFilter,
  isValidGuardAddress,
  isValidNetwork,
  isValidTab,
  mergeUrlSearch,
  writeUrlState,
  type UrlState,
  type UrlStateTarget,
} from "../../lib/guard/urlState.ts";
import { installDom } from "./domHarness.ts";

/** Well-formed Soroban contract addresses (the shape a guard has). */
const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const GUARD_B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

describe("urlState: encode", () => {
  it("encodes a full state into canonical, ordered parameters", () => {
    assert.equal(
      encodeUrlState({
        guard: GUARD_A,
        network: "testnet",
        tab: "telemetry",
        filter: "blocked",
      }),
      `guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`,
    );
  });

  it("produces the same bytes regardless of object key order", () => {
    const a = encodeUrlState({ filter: "blocked", tab: "fleet", guard: GUARD_A, network: "testnet" });
    const b = encodeUrlState({ network: "testnet", guard: GUARD_A, tab: "fleet", filter: "blocked" });
    assert.equal(a, b);
  });

  it("omits fields that are absent, so default state encodes to an empty query", () => {
    assert.equal(encodeUrlState({}), "");
    assert.equal(encodeUrlState({ guard: GUARD_A }), `guard=${GUARD_A}`);
    // An explicitly selected default preset is still a value worth sharing.
    assert.equal(encodeUrlState({ filter: DEFAULT_FILTER }), "filter=all");
  });

  it("drops invalid fields instead of writing them", () => {
    assert.equal(encodeUrlState({ guard: "javascript:alert(1)" }), "");
    assert.equal(
      encodeUrlState({ network: "mainnet" } as unknown as UrlState),
      "",
    );
    assert.equal(encodeUrlState({ tab: "<script>" } as unknown as UrlState), "");
    assert.equal(encodeUrlState({ filter: "everything" } as unknown as UrlState), "");
    // Invalid fields do not displace the valid ones beside them.
    assert.equal(
      encodeUrlState({ guard: "not-an-address", network: "testnet" }),
      "network=testnet",
    );
  });

  it("trims the guard so the encoding is canonical", () => {
    assert.equal(encodeUrlState({ guard: `  ${GUARD_A}\n` }), `guard=${GUARD_A}`);
  });
});

describe("urlState: decode", () => {
  it("decodes the documented example URL", () => {
    assert.deepEqual(
      decodeUrlState(`/?guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`),
      { guard: GUARD_A, network: "testnet", tab: "telemetry", filter: "blocked" },
    );
  });

  it("accepts a search string with or without a leading ?", () => {
    const expected = { guard: GUARD_A, network: "testnet" as const };
    assert.deepEqual(decodeUrlState(`guard=${GUARD_A}&network=testnet`), expected);
    assert.deepEqual(decodeUrlState(`?guard=${GUARD_A}&network=testnet`), expected);
  });

  it("treats missing, empty, and default parameters as the empty state", () => {
    assert.deepEqual(decodeUrlState(""), {});
    assert.deepEqual(decodeUrlState("?"), {});
    assert.deepEqual(decodeUrlState("filter=all&network=testnet").filter, "all");
    // Absent preset decodes to absent state; callers fall back to the default.
    assert.equal(decodeUrlState("?demo=true").filter, undefined);
  });

  it("ignores unknown parameters without failing", () => {
    assert.deepEqual(decodeUrlState(`?demo=true&utm_source=chat&guard=${GUARD_A}`), {
      guard: GUARD_A,
    });
  });

  it("drops malformed guard addresses", () => {
    const malformed = [
      "C", // far too short
      GUARD_A.slice(0, 55), // one character short
      `${GUARD_A}X`, // one character long
      "GAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7", // account, not contract
      GUARD_A.toLowerCase(), // base32 is case-sensitive
      GUARD_A.replace(/^./, "0"), // 0 is not in the alphabet
      "not an address at all",
    ];
    for (const guard of malformed) {
      assert.deepEqual(decodeUrlState(`?guard=${encodeURIComponent(guard)}`), {}, `guard=${guard}`);
    }
  });

  it("trims a valid guard so a padded shared link still restores", () => {
    assert.deepEqual(decodeUrlState(`?guard=%20${GUARD_A}%20`), { guard: GUARD_A });
  });

  it("drops network, tab, and filter values outside their closed sets", () => {
    assert.deepEqual(decodeUrlState("?network=mainnet"), {});
    assert.deepEqual(decodeUrlState("?network=pubnet"), {});
    assert.deepEqual(decodeUrlState("?tab=status"), {});
    assert.deepEqual(decodeUrlState("?filter=nope"), {});
    assert.deepEqual(decodeUrlState("?network="), {});
  });

  it("normalises enumerated values (trim + case) to their canonical form", () => {
    assert.deepEqual(decodeUrlState("?network=%20TESTNET%20"), { network: "testnet" });
    assert.deepEqual(decodeUrlState("?tab=Fleet"), { tab: "fleet" });
    assert.deepEqual(decodeUrlState("?filter=Blocked"), { filter: "blocked" });
  });

  it("rejects injection-style input in every parameter", () => {
    const payloads = [
      "<script>alert(1)</script>",
      "javascript:alert(1)",
      "\" onmouseover=\"alert(1)",
      "'; DROP TABLE guards; --",
      "../../../etc/passwd",
      "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    ];
    for (const payload of payloads) {
      for (const key of ["guard", "network", "tab", "filter"]) {
        const search = `?${key}=${encodeURIComponent(payload)}`;
        assert.deepEqual(decodeUrlState(search), {}, `${search} must decode to nothing`);
      }
    }
  });

  it("drops duplicated parameters instead of guessing which one is meant", () => {
    // Parameter pollution: two values for one key, even individually valid.
    assert.deepEqual(decodeUrlState(`?guard=${GUARD_A}&guard=${GUARD_B}`), {});
    assert.deepEqual(decodeUrlState(`?tab=fleet&tab=configure`), {});
    assert.deepEqual(decodeUrlState(`?filter=blocked&filter=allowed`), {});
  });

  it("never throws, however malformed the query", () => {
    assert.doesNotThrow(() => decodeUrlState("?%E0%A4%A"));
    assert.doesNotThrow(() => decodeUrlState("&&==&&"));
    assert.doesNotThrow(() => decodeUrlState("?=value"));
    assert.doesNotThrow(() => decodeUrlState("?guard[]=x"));
  });
});

describe("urlState: encode/decode round trip", () => {
  const states: UrlState[] = [
    { guard: GUARD_A, network: "testnet", tab: "telemetry", filter: "blocked" },
    { guard: GUARD_B },
    { tab: "fleet" },
    { filter: "all" },
    { network: "testnet" },
    { guard: GUARD_A, tab: "configure", filter: "diagnostic" },
  ];

  for (const state of states) {
    it(`round trips ${JSON.stringify(state)}`, () => {
      assert.deepEqual(decodeUrlState(encodeUrlState(state)), state);
      // …and the re-encoded form is byte-identical to the first encoding.
      assert.equal(encodeUrlState(decodeUrlState(encodeUrlState(state))), encodeUrlState(state));
    });
  }
});

describe("urlState: validation", () => {
  it("accepts only well-formed contract addresses as guards", () => {
    assert.equal(isValidGuardAddress(GUARD_A), true);
    assert.equal(isValidGuardAddress(GUARD_B), true);
    assert.equal(isValidGuardAddress(` ${GUARD_A} `), true);
    assert.equal(isValidGuardAddress(""), false);
    assert.equal(isValidGuardAddress("GAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7"), false);
    assert.equal(isValidGuardAddress("<script>alert(1)</script>"), false);
    assert.equal(isValidGuardAddress(`${GUARD_A}<script>`), false);
  });

  it("accepts only the console's own network", () => {
    assert.deepEqual([...URL_NETWORKS], ["testnet"]);
    assert.equal(isValidNetwork("testnet"), true);
    assert.equal(isValidNetwork("mainnet"), false);
    assert.equal(isValidNetwork(""), false);
  });

  it("accepts exactly the known tabs", () => {
    for (const tab of URL_TABS) assert.equal(isValidTab(tab), true);
    assert.equal(isValidTab("status"), false);
    assert.equal(isValidTab(""), false);
    assert.equal(isValidTab("<script>"), false);
  });

  it("accepts exactly the known filter presets", () => {
    for (const filter of URL_FILTERS) assert.equal(isValidFilter(filter), true);
    assert.equal(isValidFilter("everything"), false);
    assert.equal(isValidFilter(""), false);
  });
});

describe("urlState: mergeUrlSearch", () => {
  it("preserves parameters the module does not own", () => {
    assert.equal(
      mergeUrlSearch("?demo=true&utm_source=slack", { guard: GUARD_A, network: "testnet" }),
      `demo=true&utm_source=slack&guard=${GUARD_A}&network=testnet`,
    );
  });

  it("replaces owned parameters with the state passed in", () => {
    assert.equal(
      mergeUrlSearch(`?guard=${GUARD_B}&filter=blocked`, { guard: GUARD_A }),
      `guard=${GUARD_A}`,
    );
  });

  it("cleans invalid leftovers instead of carrying them forward", () => {
    assert.equal(
      mergeUrlSearch(
        "?guard=%3Cscript%3Ealert(1)%3C%2Fscript%3E&network=mainnet&tab=hack&filter=nope&demo=true",
        {},
      ),
      "demo=true",
    );
    // Empty state over an empty query is still empty — nothing to write.
    assert.equal(mergeUrlSearch("", {}), "");
    assert.equal(mergeUrlSearch("?", {}), "");
  });

  it("returns the query without a leading ?", () => {
    assert.equal(mergeUrlSearch("?demo=true", { network: "testnet" }), "demo=true&network=testnet");
  });
});

/** A browser whose `replaceState` rewrites the location it is given, and counts writes. */
function createTarget(search: string, pathname = "/") {
  const writes: Array<{ data: unknown; url: string }> = [];
  const location = {
    pathname,
    search: search === "" || search.startsWith("?") ? search : `?${search}`,
  };
  const entryState = { router: "next-entry" };
  const history = {
    state: entryState,
    replaceState(data: unknown, _title: string, url?: string) {
      const next = url ?? "";
      writes.push({ data, url: next });
      const [path = location.pathname, query = ""] = next.split("?");
      location.pathname = path;
      location.search = query === "" ? "" : `?${query}`;
    },
  };
  const target: UrlStateTarget = { location, history };
  return { target, writes, entryState };
}

describe("urlState: writeUrlState", () => {
  it("writes state into the current entry without navigating", () => {
    const { target, writes } = createTarget("");
    const changed = writeUrlState({ guard: GUARD_A, network: "testnet" }, target);
    assert.equal(changed, true);
    assert.equal(target.location.search, `?guard=${GUARD_A}&network=testnet`);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.url, `/?guard=${GUARD_A}&network=testnet`);
  });

  it("is a no-op when the URL already says the same thing", () => {
    const { target, writes } = createTarget(`guard=${GUARD_A}&network=testnet`);
    const state = { guard: GUARD_A, network: "testnet" as const };
    assert.equal(writeUrlState(state, target), false);
    assert.equal(writes.length, 0, "an unchanged sync must not touch history at all");
  });

  it("treats reordered parameters as unchanged", () => {
    const { target, writes } = createTarget(`network=testnet&demo=true&guard=${GUARD_A}`);
    const changed = writeUrlState({ guard: GUARD_A, network: "testnet" }, target);
    assert.equal(changed, false);
    assert.equal(writes.length, 0);
  });

  it("preserves supported and foreign state while rewriting", () => {
    const { target, writes } = createTarget(`demo=true&tab=telemetry&guard=${GUARD_B}`);
    const changed = writeUrlState(
      { guard: GUARD_A, network: "testnet", tab: "telemetry", filter: "blocked" },
      target,
    );
    assert.equal(changed, true);
    // `demo` is not ours to touch; the stale guard is replaced; the shared tab survives.
    assert.equal(
      target.location.search,
      `?demo=true&guard=${GUARD_A}&network=testnet&tab=telemetry&filter=blocked`,
    );
    assert.equal(writes.length, 1);
  });

  it("carries the current history entry's state through the rewrite", () => {
    const { target, writes, entryState } = createTarget("demo=true");
    writeUrlState({ network: "testnet" }, target);
    assert.equal(writes[0]?.data, entryState);
  });

  it("drops owned parameters the state no longer carries", () => {
    const { target } = createTarget(`guard=${GUARD_A}&network=testnet&demo=true`);
    writeUrlState({ network: "testnet" }, target);
    assert.equal(target.location.search, "?demo=true&network=testnet");
  });

  it("returns false when there is no browser to write to", () => {
    assert.equal(writeUrlState({ network: "testnet" }, null), false);
  });
});

describe("urlState: browser history integration", () => {
  it("restores shared state into the address bar without adding history entries", () => {
    installDom();
    window.history.replaceState(null, "", "/");
    const lengthBefore = window.history.length;

    // Initial page load: the shared link's state lands in the address bar…
    assert.equal(writeUrlState({ guard: GUARD_A, network: "testnet", filter: "blocked" }), true);
    assert.equal(window.location.search, `?guard=${GUARD_A}&network=testnet&filter=blocked`);
    // …by rewriting the entry, never by reloading or pushing a new one.
    assert.equal(window.history.length, lengthBefore);

    // Re-syncing the same state changes nothing at all.
    assert.equal(writeUrlState({ guard: GUARD_A, network: "testnet", filter: "blocked" }), false);
    assert.equal(window.history.length, lengthBefore);
    assert.equal(window.location.search, `?guard=${GUARD_A}&network=testnet&filter=blocked`);

    window.history.replaceState(null, "", "/");
  });
});

describe("urlState: tab routes", () => {
  it("maps route-backed tabs to their pathnames and section tabs to none", () => {
    assert.equal(TAB_PATHNAMES.console, "/");
    assert.equal(TAB_PATHNAMES.fleet, "/fleet");
    assert.equal(TAB_PATHNAMES.configure, "/configure");
    assert.equal(TAB_PATHNAMES.telemetry, null);
  });
});
