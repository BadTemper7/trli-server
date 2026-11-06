/**
 * Current active rates apply to a NEW Gate-out transaction. Rate snapshots
 * attached at Gate-in are NOT a blanket override: using them would silently
 * exclude rates added for later transactions (including Overtime).
 *
 * Exception: an already-invoiced BOTH charge must finish with its original
 * rate and allocation. Never reprice a Gate-in portion already issued or paid.
 * The original invoice is authoritative; only its matching saved rate may be
 * carried forward. No documents or historic invoices are mutated here.
 */
export function ratesForNewInvoice(booking, type, currentRates, previousInvoice = null) {
  const snapshots = Array.isArray(booking?.rateSnapshots) ? booking.rateSnapshots : [];
  if (type !== 'GATE_OUT') return snapshots.length ? snapshots : currentRates;

  const previouslyCollectedBoth = new Set((previousInvoice?.lines || [])
    .filter(line => line.collectionPoint === 'BOTH' && line.rateId && Number(line.amount) > 0)
    .map(line => String(line.rateId)));
  const carried = snapshots.filter(rate => previouslyCollectedBoth.has(String(rate._id))
    && rate.collectionPoint === 'BOTH');
  const carriedNames = new Set(carried.map(rate => rate.name));
  return [
    ...currentRates.filter(rate => !carriedNames.has(rate.name)),
    ...carried,
  ];
}
