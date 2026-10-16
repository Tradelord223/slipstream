import type { DeliveryStatus, Helpers, Signal, Thread } from "../types.ts";

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

/** Every signal on a thread's latest incoming message, most important first. Servers that predate `signals` only send the first. */
export function threadSignals(t: Thread): Signal[] {
  if (t.signals && t.signals.length > 0) return t.signals;
  if (t.signalDetail) return [t.signalDetail];
  // No detail came with the kind (a code, or a sign-in alert); the chips don't need any.
  return t.signal ? [{ kind: t.signal } as Signal] : [];
}

/**
 * The first signal the person's helper settings allow. A code also has to be fresh, so a sign-in alert whose
 * code has expired shows as the alert. Rows and message cards both choose with this, so they agree.
 */
export function pickSignal(signals: readonly Signal[], h: Helpers, codeFresh: boolean): Signal | null {
  return (
    signals.find((s) => (s.kind === "code" ? h.codes && codeFresh : s.kind === "security" ? h.securityAlerts : s.kind === "urgent" ? h.urgent : true)) ?? null
  );
}
