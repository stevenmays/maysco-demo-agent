export const SAGA_STATUSES = [
  "received",
  "awaiting_review",
  "cleared",
  "approved",
  "transferring",
  "paid",
  "reversing",
  "held",
] as const;

export type SagaStatus = (typeof SAGA_STATUSES)[number];

// The whole saga in one table. `transferring` is the pivot: before it, a change
// sends the saga back to `received`; after it, only a reversal can undo the money.
const NEXT: Record<SagaStatus, readonly SagaStatus[]> = {
  received: ["cleared", "awaiting_review"],
  awaiting_review: ["approved", "held", "received"],
  cleared: ["transferring", "received"],
  approved: ["transferring", "received"],
  transferring: ["paid"],
  paid: ["reversing"],
  reversing: ["held"],
  held: [],
};

export function canTransition(from: SagaStatus, to: SagaStatus): boolean {
  return NEXT[from].includes(to);
}

export const BEFORE_TRANSFER: readonly SagaStatus[] = [
  "received",
  "awaiting_review",
  "cleared",
  "approved",
];
