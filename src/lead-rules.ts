export function assertLeadAvailable(
  status: string,
  sold: number,
  slots: number,
  alreadyPurchased: boolean,
  categoryMatches: boolean,
) {
  if (!categoryMatches)
    throw new Error("Lead category does not match this supplier");
  if (alreadyPurchased) throw new Error("Lead is already unlocked");
  if (
    !["ACTIVE", "PARTIALLY_SOLD"].includes(status) ||
    sold >= Math.min(slots, 5)
  )
    throw new Error("Lead is unavailable");
}
