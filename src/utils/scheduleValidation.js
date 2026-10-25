const TIME_ZONE = 'Asia/Manila';

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function getManilaTodayAndHour(date = new Date()) {
  const parts = zonedParts(date);
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

export function validateHourlySchedule(dateValue, timeValue, label = 'Scheduled time') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ''))) {
    return `${label} date must use YYYY-MM-DD format.`;
  }

  const match = /^([01]\d|2[0-3]):00$/.exec(String(timeValue || ''));
  if (!match) {
    return `${label} must be selected in 1-hour intervals.`;
  }

  const { today, hour: currentHour } = getManilaTodayAndHour();

  if (dateValue < today) {
    return `${label} date cannot be in the past.`;
  }

  if (dateValue === today && Number(match[1]) <= currentHour) {
    return `${label} must be a future full-hour slot.`;
  }

  return null;
}
