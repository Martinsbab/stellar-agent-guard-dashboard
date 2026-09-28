"use client";

import { useMemo } from "react";
import { describeGuardEvent, explainReason } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, relativeTime, short, starLink } from "./bits.tsx";
import {
  DEFAULT_FILTER,
  URL_FILTERS,
  type FilterPreset,
} from "../lib/guard/urlState.ts";

/** The operator-facing label for each filter preset. */
const FILTER_LABELS: Record<FilterPreset, string> = {
  all: "All",
  allowed: "Allowed",
  blocked: "Blocked",
  diagnostic: "Diagnostics",
};

/**
 * Whether an event belongs under a preset.
 *
 * The decision presets filter on what the guard decided (`decision.result`);
 * the diagnostic preset filters on where the row came from — this console's own
 * refused-write diagnostics (`source`). Lifecycle rows (heartbeats, freezes,
 * policy installs) carry no decision, so they appear under "all" only.
 */
function matchesPreset(event: GuardEvent, preset: FilterPreset): boolean {
  switch (preset) {
    case "all":
      return true;
    case "allowed":
      return event.decision?.result === "allowed";
    case "blocked":
      return event.decision?.result === "blocked";
    case "diagnostic":
      return event.source === "diagnostic";
  }
}

/**
 * The live event feed.
 *
 * Two things are stated on the panel rather than glossed over, because both
 * change how the feed should be read:
 *
 *   - Soroban RPC has no push stream, so this polls `getEvents` with a cursor and
 *     the real latency floor is the ledger close interval, not the poll interval.
 *   - A *refused* decision never becomes a transaction: the guard returns `Err`,
 *     which rolls the event back. So the feed can only carry refused decisions
 *     that this console produced itself, decoded from the enforced simulation's
 *     diagnostics and labelled `diagnostic`. Absence of refusals here does not
 *     mean absence of refusals on chain.
 */
export function TelemetryFeed() {
  const { events, feed, startWatching, stopWatching, clearEvents, guard, filterPreset, setFilterPreset } =
    useGuard();

  // The preset is part of the shared URL state (see `lib/guard/urlState.ts`),
  // so re-rendering here on a preset change is what a shared `?filter=blocked`
  // link restores into.
  const visibleEvents = useMemo(
    () => events.filter((event) => matchesPreset(event, filterPreset)),
    [events, filterPreset],
  );

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Telemetry</h2>
        <div className="row">
          {feed.watching && <span className="pill ok">polling</span>}
          {feed.latestLedger !== null && <span className="tiny muted">ledger {feed.latestLedger}</span>}
          {feed.watching ? (
            <button className="secondary" onClick={stopWatching}>
              Stop
            </button>
          ) : (
            <button onClick={startWatching}>Start watching</button>
          )}
          <button className="secondary" onClick={clearEvents} disabled={events.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className="row" role="group" aria-label="Filter events" style={{ marginTop: 8 }}>
        <span className="tiny muted">Filter</span>
        {URL_FILTERS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={preset === filterPreset ? undefined : "secondary"}
            aria-pressed={preset === filterPreset}
            onClick={() => setFilterPreset(preset)}
          >
            {FILTER_LABELS[preset]}
          </button>
        ))}
        {filterPreset !== DEFAULT_FILTER && (
          <span className="tiny muted">
            {visibleEvents.length} of {events.length} event(s)
          </span>
        )}
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tailed from Soroban RPC&apos;s <code>getEvents</code> with a cursor, so no event is delivered
        twice and none is skipped between polls. Soroban has no push stream — the floor on latency is
        the ledger close interval (roughly 5s), not the 5s poll.
        {feed.lastPolledAt && ` Last poll ${relativeTime(feed.lastPolledAt)}.`}
      </p>

      <div className="notice info">
        <strong>Refused decisions cannot reach this feed from the ledger</strong>
        <span className="tiny">
          When the guard refuses a call it returns an error, which rolls the event back — so a
          refused decision has no transaction and no committed event. Rows marked{" "}
          <em>diagnostic</em> are the refusals this console produced itself, decoded from the failed
          enforced simulation before broadcast. An empty feed is not evidence that nothing was
          refused on chain.
        </span>
      </div>

      {feed.error && <ErrorBlock title="The event feed could not poll" detail={feed.error} />}

      {events.length === 0 ? (
        <p className="tiny muted">
          {feed.watching
            ? "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
            : "Start watching to tail this guard's events."}
        </p>
      ) : visibleEvents.length === 0 ? (
        <p className="tiny muted">
          No buffered event matches the current filter. Choose &quot;All&quot; above to see the
          whole feed.
        </p>
      ) : (
        <div className="scrolly">
          <table className="events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Decision</th>
                <th>Source</th>
                <th>Ledger</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event, index) => (
                <tr key={`${event.topic}-${event.transactionHash ?? "-"}-${event.ledger ?? "-"}-${index}`}>
                  <td>
                    <div>{labelFor(event)}</div>
                    <div className="tiny muted mono">{describeGuardEvent(event)}</div>
                  </td>
                  <td>
                    {event.decision ? (
                      event.decision.result === "blocked" ? (
                        <span className="pill danger">{event.decision.reason ?? "blocked"}</span>
                      ) : (
                        <span className="pill ok">allowed</span>
                      )
                    ) : (
                      <span className="muted tiny">—</span>
                    )}
                    {event.decision?.result === "blocked" && event.decision.reason && (
                      <div className="tiny muted">{explainReason(event.decision.reason)}</div>
                    )}
                  </td>
                  <td>
                    <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>
                      {event.source}
                    </span>
                  </td>
                  <td className="mono tiny">{event.ledger ?? "—"}</td>
                  <td>{event.transactionHash ? starLink(event.transactionHash) : <span className="tiny muted">none — never broadcast</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Showing {visibleEvents.length} of {events.length} buffered event(s) from{" "}
        <span className="mono">{short(guard, 8, 6)}</span>.
      </p>
    </div>
  );
}

function labelFor(event: GuardEvent): string {
  switch (event.kind) {
    case "auth_checked":
      return "Authorization decision";
    case "heartbeat":
      return "Agent heartbeat";
    case "initialized":
      return "Account initialized";
    case "frozen":
      return "Admin freeze";
    case "unfrozen":
      return "Admin unfreeze";
    case "policy_set":
      return "Policy installed";
    case "policy_revoked":
      return "Policy revoked";
    default:
      return event.topic;
  }
}
