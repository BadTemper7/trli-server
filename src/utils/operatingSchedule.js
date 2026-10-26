// Booking slots are one-hour intervals in Asia/Manila.
// 24:00 is allowed only as an exclusive closing boundary: 00:00..23:00.
export const DEFAULT_OPERATING_SCHEDULE = Object.freeze({
  openingTime:'00:00',closingTime:'24:00',operatingDays:[0,1,2,3,4,5,6],maxBookingsPerHour:4,active:true,
});
const START_TIME = /^([01]\d|2[0-3]):00$/;
const END_TIME = /^(?:[01]\d|2[0-3]|24):00$/;
export function is24HourSchedule(schedule) {
  return schedule?.openingTime === '00:00' && schedule?.closingTime === '24:00';
}
export function validateOperatingSchedule(schedule) {
  if (!schedule || !START_TIME.test(schedule.openingTime) || !END_TIME.test(schedule.closingTime)
    || schedule.openingTime >= schedule.closingTime) return 'Opening and closing times must be hourly (24:00 is allowed only as a closing boundary).';
  if (!Number.isInteger(Number(schedule.maxBookingsPerHour)) || Number(schedule.maxBookingsPerHour) < 1 || Number(schedule.maxBookingsPerHour) > 100) return 'Maximum bookings per hour must be 1–100.';
  if (!Array.isArray(schedule.operatingDays) || !schedule.operatingDays.length || schedule.operatingDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'Select at least one valid operating day.';
  if (typeof schedule.active !== 'boolean') return 'Operating schedule active flag must be a boolean.';
  return null;
}
export function validateOperationalHour(day, hour, schedule) {
  const error=validateOperatingSchedule(schedule);
  if (error) return error;
  if (!schedule.active) return 'Bookings are disabled.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day||''))) return 'Invalid date.';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== day || !schedule.operatingDays.includes(date.getUTCDay())) return 'Date is outside operating days.';
  if (!START_TIME.test(String(hour||'')) || hour < schedule.openingTime || hour >= schedule.closingTime) return 'Hour is outside operational hours.';
  return null;
}
