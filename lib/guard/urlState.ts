/**
 * URL query-parameter state for shareable console views.
 *
 * An operator debugging a refusal should not have to describe the view in
 * prose: "the blocked transfers on guard X, testnet" is exactly what the
 * address bar already says. This module is the single encoder/decoder for that
 * address-bar state — the active guard, the network, the active tab, and the
 * telemetry filter preset travel as
 * `?guard=…&network=…&tab=…&filter=…`, and a shared link restores the same view
 * when it is opened.
 *
 * Three rules shape it, and all three come from treating the query string as
 * untrusted input:
 *
 *   1. Everything decoded from the URL is validated before it can become
 *      state. Enumerated parameters must match a closed set; the guard must
 *      match the exact shape of a Soroban contract address. A malformed,
 *      duplicated, or injection-style value is dropped, never propagated —
 *      dropping it leaves the caller on its safe default instead of a view the
 *      link invented.
 *   2. Encoding is canonical: parameters appear in a fixed order, only when
 *      they carry a valid value, so a shared URL stays clean and two encodes
 *      of the same state are byte-identical.
 *   3. Synchronising never reloads the page. `writeUrlState` rewrites the
 *      current history entry in place with `replaceState` and does nothing at
 *      all when the URL already says what the state says, so a state change
 *      cannot pile up history entries, interrupt a chain read, or re-run the
 *      app just to update the address bar.
 */

import { looksLikeContractAddress } from "./instance.ts";
import { NETWORK } from "./network.ts";

/** The query parameters this module owns. Order is the canonical encode order. */
export const URL_STATE_KEYS = ["guard", "network", "tab", "filter"] as const;
export type UrlStateKey = (typeof URL_STATE_KEYS)[number];

/**
 * The networks a URL may name. The console is pinned to the network it was
 * built for (`NETWORK`), so `testnet` is the only accepted value: decoding
 * `network=mainnet` (or anything else) is dropped rather than mis-restored,
 * because a view that claims to show another network would be a lie the
 * operator cannot afford.
 */
export const URL_NETWORKS = [NETWORK.name] as const;
export type UrlNetwork = (typeof URL_NETWORKS)[number];

/**
 * The console's views. `console`, `fleet`, and `configure` mirror the nav tabs
 * and are backed by routes; `telemetry` names the console's live feed section,
 * which has no route of its own.
 */
export const URL_TABS = ["console", "telemetry", "fleet", "configure"] as const;
export type UrlTab = (typeof URL_TABS)[number];

/**
 * The route each tab lives on, or `null` for tabs that are sections of the
 * console rather than routes. Used to restore a shared `?tab=…` by navigating
 * to the view it names.
 */
export const TAB_PATHNAMES: Readonly<Record<UrlTab, string | null>> = {
  console: "/",
  telemetry: null,
  fleet: "/fleet",
  configure: "/configure",
};

/**
 * The telemetry feed's filter presets. Each maps onto a field the events
 * already carry — `decision.result` for `allowed`/`blocked`, `source` for
 * `diagnostic` — so a preset is a saved view over data the feed already has,
 * never a new server-side query.
 */
export const URL_FILTERS = ["all", "allowed", "blocked", "diagnostic"] as const;
export type FilterPreset = (typeof URL_FILTERS)[number];

/** The preset a feed is under when no `filter` parameter was shared. */
export const DEFAULT_FILTER: FilterPreset = "all";

/** The shareable slice of console state. Every field is optional. */
export interface UrlState {
  /** Active guard: a Soroban contract (`C…`) address. */
  guard?: string;
  /** Network the view targets. */
  network?: UrlNetwork;
  /** Active tab / console section. */
  tab?: UrlTab;
  /** Telemetry filter preset. */
  filter?: FilterPreset;
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * A well-formed Soroban contract address — the exact shape a guard has.
 * Length-anchored and base32-cased, so scripted, truncated, or otherwise
 * mangled values cannot pass as an address.
 */
export function isValidGuardAddress(value: string): boolean {
  return looksLikeContractAddress(value);
}

export function isValidNetwork(value: string): value is UrlNetwork {
  return (URL_NETWORKS as readonly string[]).includes(value);
}

export function isValidTab(value: string): value is UrlTab {
  return (URL_TABS as readonly string[]).includes(value);
}

export function isValidFilter(value: string): value is FilterPreset {
  return (URL_FILTERS as readonly string[]).includes(value);
}

/**
 * Read an enumerated parameter, normalised for its closed set (trimmed and
 * lowercased). Returns `null` when the parameter is absent *or duplicated*:
 * `?tab=fleet&tab=configure` is parameter pollution, not a value to guess at.
 */
function enumParam(params: URLSearchParams, key: UrlStateKey): string | null {
  const values = params.getAll(key);
  if (values.length !== 1) return null;
  const raw = values[0];
  if (raw === undefined) return null;
  const normalised = raw.trim().toLowerCase();
  return normalised === "" ? null : normalised;
}

/**
 * Accepts a raw search string (leading `?` optional), a path carrying a query
 * (`/?guard=…`), or a parsed one — anything an address bar can hand over.
 */
function toParams(search: string | URLSearchParams): URLSearchParams {
  if (typeof search !== "string") return search;
  const query = search.includes("?") ? search.slice(search.indexOf("?") + 1) : search;
  return new URLSearchParams(query);
}

// ── Decode: URL → state ────────────────────────────────────────────────────

/**
 * Decode a query string into validated console state.
 *
 * Unknown parameters are ignored (they belong to other features, such as
 * `?demo=true`), and any owned parameter that fails validation — malformed
 * address, unknown enum, injection payload, repeated key — is omitted, so the
 * caller falls back to its default. Never throws, however malformed the input.
 */
export function decodeUrlState(search: string | URLSearchParams): UrlState {
  const params = toParams(search);
  const state: UrlState = {};

  const guard = params.getAll("guard");
  if (guard.length === 1) {
    const value = (guard[0] ?? "").trim();
    if (isValidGuardAddress(value)) state.guard = value;
  }

  const network = enumParam(params, "network");
  if (network !== null && isValidNetwork(network)) state.network = network;

  const tab = enumParam(params, "tab");
  if (tab !== null && isValidTab(tab)) state.tab = tab;

  const filter = enumParam(params, "filter");
  if (filter !== null && isValidFilter(filter)) state.filter = filter;

  return state;
}

// ── Encode: state → URL ────────────────────────────────────────────────────

/**
 * Encode validated console state into a canonical query string (no leading
 * `?`). Invalid fields are dropped rather than written, and the key order is
 * fixed, so the same state always encodes to the same bytes.
 */
export function encodeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.guard !== undefined) {
    const guard = state.guard.trim();
    if (isValidGuardAddress(guard)) params.set("guard", guard);
  }
  if (state.network !== undefined && isValidNetwork(state.network)) {
    params.set("network", state.network);
  }
  if (state.tab !== undefined && isValidTab(state.tab)) {
    params.set("tab", state.tab);
  }
  if (state.filter !== undefined && isValidFilter(state.filter)) {
    params.set("filter", state.filter);
  }
  return params.toString();
}

// ── Merge: preserve foreign state, own ours ────────────────────────────────

/**
 * Rebuild a search string: existing parameters that this module does not own
 * (the demo flag, future features) are preserved untouched; parameters this
 * module owns are replaced by the validated state passed in — which also
 * cleans them: an invalid leftover like `&guard=%3Cscript%3E` is removed, not
 * kept. Returns the query without a leading `?` (possibly empty).
 */
export function mergeUrlSearch(search: string, state: UrlState): string {
  const params = toParams(search);
  for (const key of URL_STATE_KEYS) params.delete(key);
  const encoded = encodeUrlState(state);
  if (encoded !== "") {
    for (const [key, value] of new URLSearchParams(encoded)) params.append(key, value);
  }
  return params.toString();
}

/** Order-insensitive parameter equality, so reordering counts as "unchanged". */
function sameParams(a: URLSearchParams, b: URLSearchParams): boolean {
  const canonical = (params: URLSearchParams): string =>
    JSON.stringify(
      [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
        keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
      ),
    );
  return canonical(a) === canonical(b);
}

// ── Write: state → address bar, without a reload ───────────────────────────

/** The slice of the browser history API the writer needs (injectable for tests). */
export interface UrlStateHistory {
  replaceState(data: unknown, unused: string, url?: string): void;
  /** The current entry's state, carried across rewrites (Next's router stores state here). */
  readonly state?: unknown;
}

export interface UrlStateTarget {
  location: { pathname: string; search: string };
  history: UrlStateHistory;
}

function defaultTarget(): UrlStateTarget | null {
  if (typeof window === "undefined") return null;
  return { location: window.location, history: window.history };
}

/**
 * Mirror console state into the address bar of the current history entry.
 *
 * Rewrites with `replaceState` — never a navigation — so no page reload
 * happens and no history entry is added; pressing Back still leaves the view
 * rather than undoing one state tweak at a time. Returns `true` when the URL
 * actually changed, `false` when it already said the same thing (or there is
 * no browser to write to), which makes repeated syncs free.
 */
export function writeUrlState(state: UrlState, target?: UrlStateTarget | null): boolean {
  const resolved = target === undefined ? defaultTarget() : target;
  if (resolved === null) return false;

  const { location, history } = resolved;
  const nextSearch = mergeUrlSearch(location.search, state);
  if (sameParams(toParams(location.search), toParams(nextSearch))) return false;

  const url = nextSearch === "" ? location.pathname : `${location.pathname}?${nextSearch}`;
  history.replaceState(history.state ?? null, "", url);
  return true;
}
