/** Active billable rate coverage determines which load statuses can be booked.
 * Exclude universal Overtime: an overtime fallback alone is not a usable rate
 * for an otherwise unconfigured container. This helper is shared by the
 * public selector and the server-side Pre-Advice validation.
 */
export const BOOKING_LOAD_STATUSES = Object.freeze(['EMPTY', 'LOADED']);
export function availableBookingLoadStatuses(rates, booking, asOf = new Date()) {
  const category = booking.containerType === 'REEFER' ? 'REEFER' : 'STANDARD';
  return BOOKING_LOAD_STATUSES.filter(loadStatus => rates.some(rate => {
    if (rate.status !== 'ACTIVE') return false;
    if (rate.effectiveFrom && new Date(rate.effectiveFrom) > asOf) return false;
    if (['Overtime', 'Total Handling Reference'].includes(rate.name)) return false;
    if (!['GATE_IN', 'GATE_OUT', 'BOTH'].includes(rate.collectionPoint)) return false;
    if ((rate.containerCategory || 'STANDARD') !== category) return false;
    if (!['ALL', booking.transactionClassification].includes(rate.classification)) return false;
    if (!['ALL', booking.containerSize].includes(rate.containerSize || 'ALL')) return false;
    return ['ALL', loadStatus].includes(rate.loadStatus);
  }));
}
