import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with correct conflict handling. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Round to a fixed number of decimals for display. */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format a calorie or macro figure with a unit suffix. */
export function formatNutrient(value: number, unit: string, decimals = 0): string {
  return `${formatNumber(value, decimals)} ${unit}`;
}

/** Today's date in ISO form, in a given timezone (defaulting to the user's). */
export function todayIso(timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Human-readable relative time, e.g. "5 minutes ago". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(months / 12)} year${months < 24 ? '' : 's'} ago`;
}

/** A short, stable id for idempotency keys. */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

/** Confidence band to a user-facing label. */
export function confidenceLabel(band: string): string {
  switch (band) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'low':
      return 'Low confidence';
    default:
      return 'Confidence unknown';
  }
}
