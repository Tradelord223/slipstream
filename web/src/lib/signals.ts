import type { DeliveryStatus, Helpers, Signal, SignalKind, Thread } from "../types.ts";

/** A one-time code is worth offering for this long after the message arrived. */
export const CODE_FRESH_MS = 15 * 60 * 1000;

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  ordered: "Ordered",
  shipped: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delayed: "Delayed",
  customs: "At customs",
};

export const deliveryLabel = (status: DeliveryStatus | undefined): string => (status && DELIVERY_LABEL[status]) || "Delivery update";

/** Milliseconds until a code stops being fresh; 0 or less means it already has. */
export const codeFreshFor = (at: number | null | undefined, now = Date.now()): number => (at ? at + CODE_FRESH_MS - now : 0);

/** The one signal a list row shows, after the person's helper settings. Codes still need `codeFreshFor` > 0. */
export function rowSignal(t: Thread, h: Helpers): { kind: SignalKind; detail: Signal | null } | null {
  switch (t.signal) {
    case "code":
      return h.codes && t.signalAt ? { kind: "code", detail: t.signalDetail } : null;
    case "delivery":
      return { kind: "delivery", detail: t.signalDetail };
    case "security":
      return h.securityAlerts ? { kind: "security", detail: t.signalDetail } : null;
    case "urgent":
      return h.urgent ? { kind: "urgent", detail: t.signalDetail } : null;
    default:
      return null;
  }
}

/** The signal a message card shows: the first one the person's helper settings allow. */
export function cardSignal(signals: Signal[], h: Helpers): Signal | null {
  return (
    signals.find((s) => (s.kind === "code" ? h.codes : s.kind === "security" ? h.securityAlerts : s.kind === "urgent" ? h.urgent : true)) ?? null
  );
}
