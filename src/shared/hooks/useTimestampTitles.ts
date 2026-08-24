"use client";

import { useEffect, type RefObject } from "react";

// react-json-view-lite exposes no per-value render hook (checked its type
// defs: Props only take style/shouldExpandNode/clickToExpandNode/
// beforeExpandChange/compactTopLevel), so a custom className marker + DOM
// walk is the only way to add a tooltip without changing what value is
// actually displayed -- the tree's byte-accurate rendering is the point.
export const TIMESTAMP_VALUE_MARKER_CLASS = "json-tree-number-value";

const TIMESTAMP_FIELD_NAME = /created|updated|modified|timestamp|(^|_)ts$|_at$/i;
// Unix epoch bounds spanning year 2000 to year 2100, checked at both
// seconds and millisecond precision (both are common on the wire).
const EPOCH_SECONDS_MIN = 946684800;
const EPOCH_SECONDS_MAX = 4102444800;
const EPOCH_MS_MIN = EPOCH_SECONDS_MIN * 1000;
const EPOCH_MS_MAX = EPOCH_SECONDS_MAX * 1000;

function epochValueToDate(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  if (value >= EPOCH_SECONDS_MIN && value <= EPOCH_SECONDS_MAX) return new Date(value * 1000);
  if (value >= EPOCH_MS_MIN && value <= EPOCH_MS_MAX) return new Date(value);
  return null;
}

/** Adds this file's own JSON tree number-value className onto a react-json-view-lite style object. */
export function withTimestampTitleMarker<T extends { numberValue: string }>(style: T): T {
  return { ...style, numberValue: `${style.numberValue} ${TIMESTAMP_VALUE_MARKER_CLASS}` };
}

// Adds a human-readable date/time title (tooltip) to marked number values
// whose field name looks like a timestamp and whose value is a plausible
// Unix epoch. Re-runs on any DOM change inside the container (expanding an
// individual node is internal react-json-view-lite state, not a prop
// change this component would otherwise see) and is idempotent, so it's
// safe to call repeatedly as the tree gets expanded/collapsed.
export function useTimestampTitles(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    const annotate = () => {
      const values = container.querySelectorAll<HTMLElement>(`.${TIMESTAMP_VALUE_MARKER_CLASS}`);
      for (const valueEl of values) {
        if (valueEl.title) continue;
        const fieldName = valueEl.previousElementSibling?.textContent?.replace(/:\s*$/, "").trim();
        if (!fieldName || !TIMESTAMP_FIELD_NAME.test(fieldName)) continue;
        const date = epochValueToDate(Number(valueEl.textContent));
        if (!date) continue;
        valueEl.title = date.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "medium",
        });
      }
    };

    annotate();
    const observer = new MutationObserver(annotate);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, active]);
}
