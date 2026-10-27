/**
 * Storage duration in Asia/Manila (UTC+08:00, no daylight saving time).
 * CALENDAR_DAYS bills every local date touched, INCLUDING entry and exit dates.
 * Example: Oct 27 22:00 -> Oct 28 01:00 = 2 billable calendar days.
 * Physical elapsed time remains available separately for reporting.
 */
const MS_PER_DAY = 86_400_000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export const STORAGE_ROUNDING = Object.freeze({
  CALENDAR_DAYS: 'CALENDAR_DAYS',
  CEIL_24_HOURS: 'CEIL_24_HOURS', // Legacy contractual option only.
});

function validInstant(value, name) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is required.`);
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid ${name}.`);
  return instant;
}

/** Manila has no DST. Shift the UTC timestamp by +08:00 to read its Manila date. */
function manilaDayIndex(date) {
  return Math.floor((date.getTime() + MANILA_OFFSET_MS) / MS_PER_DAY);
}

export function manilaScheduledInstant(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
    throw new Error('Scheduled Gate-out must have a valid date and time.');
  }
  const instant = new Date(`${day}T${time}:00+08:00`);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid scheduled Gate-out calendar date.');
  const localIso = new Date(instant.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 16);
  if (localIso !== `${day}T${time}`) {
    throw new Error('Invalid scheduled Gate-out calendar date.');
  }
  return instant;
}

/** Storage days from physical Gate-in to a quote time, now, or actual release. */
export function storageDaysBetween(gateInAt, gateOutAt = new Date(), rounding = STORAGE_ROUNDING.CALENDAR_DAYS) {
  const start = validInstant(gateInAt, 'actual Gate-in time');
  const end = validInstant(gateOutAt, 'Gate-out time');
  if (end < start) throw new Error('Gate-out time must follow physical gate-in.');
  if (rounding === STORAGE_ROUNDING.CEIL_24_HOURS) {
    return Math.max(1, Math.ceil((end - start) / MS_PER_DAY));
  }
  if (rounding !== STORAGE_ROUNDING.CALENDAR_DAYS) throw new Error('Unsupported storage billing-day rule.');
  return manilaDayIndex(end) - manilaDayIndex(start) + 1;
}
