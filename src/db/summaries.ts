/**
 * Daily summary engine (spec §88, §89, §130).
 *
 * The summary row is derived state: it is always recomputed from the underlying logs
 * rather than incremented, so editing or deleting a meal can never leave a stale total
 * behind. The spec is explicit that old totals must not survive (`§130`).
 *
 * Every function here runs inside a caller-supplied transaction so the write and the
 * summary update commit atomically (spec §87).
 */

import type { TransactionClient } from './client';
import { sumNutrients, type NutrientValues } from '@/lib/nutrition';
import { round } from '@/lib/units';

export interface DailySummaryRow {
  readonly id: string;
  readonly summary_date: string;
  readonly calories_kcal: number;
  readonly protein_g: number;
  readonly carbs_g: number;
  readonly fat_g: number;
  readonly fiber_g: number;
  readonly sugar_g: number;
  readonly sodium_mg: number;
  readonly water_ml: number;
  readonly workout_minutes: number;
  readonly steps: number;
  readonly sleep_minutes: number | null;
  readonly meals_logged: number;
  readonly revision: number;
}

/** Raw shape as the driver returns it, before numeric/string normalisation. */
type RawSummaryRow = Record<string, string | number | bigint | null>;

/**
 * PostgreSQL returns `numeric` and `bigint` as strings to preserve precision, and PGlite
 * does the same. Every consumer of this module expects real numbers, and a string leaking
 * into the API would break arithmetic and chart rendering silently. So normalisation
 * happens here, once, rather than at each call site.
 */
function toNumber(value: string | number | bigint | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSummary(raw: RawSummaryRow): DailySummaryRow {
  return {
    id: String(raw.id),
    summary_date: String(raw.summary_date),
    calories_kcal: toNumber(raw.calories_kcal),
    protein_g: toNumber(raw.protein_g),
    carbs_g: toNumber(raw.carbs_g),
    fat_g: toNumber(raw.fat_g),
    fiber_g: toNumber(raw.fiber_g),
    sugar_g: toNumber(raw.sugar_g),
    sodium_mg: toNumber(raw.sodium_mg),
    water_ml: toNumber(raw.water_ml),
    workout_minutes: toNumber(raw.workout_minutes),
    steps: toNumber(raw.steps),
    sleep_minutes:
      raw.sleep_minutes === null || raw.sleep_minutes === undefined
        ? null
        : toNumber(raw.sleep_minutes),
    meals_logged: toNumber(raw.meals_logged),
    revision: toNumber(raw.revision, 1),
  };
}

/**
 * Recompute one user's summary for one date from source data and upsert it.
 *
 * Runs as the table owner (the caller's transaction), which is deliberate: this is
 * derived-state maintenance across several tables, and it must see the user's rows
 * regardless of which role the request ran as. It is only ever called with a user id
 * that the request already authenticated as.
 */
export async function recalculateDailySummary(
  tx: TransactionClient,
  userId: string,
  date: string,
): Promise<DailySummaryRow> {
  // Nutrients come from meal_items joined through meals, so a deleted meal's items are
  // automatically excluded.
  const nutrientRows = await tx.query<{
    calories_kcal: string | number | null;
    protein_g: string | number | null;
    carbs_g: string | number | null;
    fat_g: string | number | null;
    fiber_g: string | number | null;
    sugar_g: string | number | null;
    sodium_mg: string | number | null;
  }>(
    `SELECT
       COALESCE(SUM(mi.calories_kcal), 0) AS calories_kcal,
       COALESCE(SUM(mi.protein_g), 0)     AS protein_g,
       COALESCE(SUM(mi.carbs_g), 0)       AS carbs_g,
       COALESCE(SUM(mi.fat_g), 0)         AS fat_g,
       COALESCE(SUM(mi.fiber_g), 0)       AS fiber_g,
       COALESCE(SUM(mi.sugar_g), 0)       AS sugar_g,
       COALESCE(SUM(mi.sodium_mg), 0)     AS sodium_mg
     FROM meals m
     JOIN meal_items mi ON mi.meal_id = m.id
     WHERE m.user_id = $1 AND m.meal_date = $2`,
    [userId, date],
  );

  const mealsRow = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM meals WHERE user_id = $1 AND meal_date = $2`,
    [userId, date],
  );

  const waterRow = await tx.query<{ ml: number | null }>(
    `SELECT COALESCE(SUM(amount_ml), 0)::int AS ml FROM water_logs WHERE user_id = $1 AND logged_on = $2`,
    [userId, date],
  );

  // Only completed sessions count toward the day's activity minutes.
  const workoutRow = await tx.query<{ minutes: number | null }>(
    `SELECT COALESCE(SUM(COALESCE(duration_seconds, 0)), 0)::int AS minutes
       FROM workout_sessions
      WHERE user_id = $1 AND session_date = $2 AND status = 'completed'`,
    [userId, date],
  );

  const activityRow = await tx.query<{ steps: number | null }>(
    `SELECT COALESCE(SUM(COALESCE(steps, 0)), 0)::int AS steps
       FROM activity_logs WHERE user_id = $1 AND logged_on = $2`,
    [userId, date],
  );

  const recoveryRow = await tx.query<{ sleep_minutes: number | null }>(
    `SELECT MAX(sleep_minutes) AS sleep_minutes FROM recovery_logs WHERE user_id = $1 AND logged_on = $2`,
    [userId, date],
  );

  const raw = nutrientRows[0];
  const nutrients: NutrientValues = sumNutrients([
    {
      calories_kcal: Number(raw?.calories_kcal ?? 0),
      protein_g: Number(raw?.protein_g ?? 0),
      carbs_g: Number(raw?.carbs_g ?? 0),
      fat_g: Number(raw?.fat_g ?? 0),
      fiber_g: Number(raw?.fiber_g ?? 0),
      sugar_g: Number(raw?.sugar_g ?? 0),
      sodium_mg: Number(raw?.sodium_mg ?? 0),
    },
  ]);

  const workoutMinutes = Math.round((workoutRow[0]?.minutes ?? 0) / 60);

  const rows = await tx.query<RawSummaryRow>(
    `INSERT INTO daily_summaries
       (user_id, summary_date, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g,
        sodium_mg, water_ml, workout_minutes, steps, sleep_minutes, meals_logged, revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)
     ON CONFLICT (user_id, summary_date) DO UPDATE SET
       calories_kcal   = EXCLUDED.calories_kcal,
       protein_g       = EXCLUDED.protein_g,
       carbs_g         = EXCLUDED.carbs_g,
       fat_g           = EXCLUDED.fat_g,
       fiber_g         = EXCLUDED.fiber_g,
       sugar_g         = EXCLUDED.sugar_g,
       sodium_mg       = EXCLUDED.sodium_mg,
       water_ml        = EXCLUDED.water_ml,
       workout_minutes = EXCLUDED.workout_minutes,
       steps           = EXCLUDED.steps,
       sleep_minutes   = EXCLUDED.sleep_minutes,
       meals_logged    = EXCLUDED.meals_logged,
       calculated_at   = now(),
       revision        = daily_summaries.revision + 1
     RETURNING id, summary_date::text AS summary_date, calories_kcal, protein_g, carbs_g, fat_g,
               fiber_g, sugar_g, sodium_mg, water_ml, workout_minutes, steps, sleep_minutes,
               meals_logged, revision`,
    [
      userId,
      date,
      nutrients.calories_kcal,
      nutrients.protein_g,
      nutrients.carbs_g,
      nutrients.fat_g,
      nutrients.fiber_g,
      nutrients.sugar_g,
      nutrients.sodium_mg,
      waterRow[0]?.ml ?? 0,
      workoutMinutes,
      activityRow[0]?.steps ?? 0,
      recoveryRow[0]?.sleep_minutes ?? null,
      mealsRow[0]?.n ?? 0,
    ],
  );

  const inserted = rows[0];
  if (!inserted) throw new Error('Failed to upsert the daily summary.');
  return normalizeSummary(inserted);
}

/** Read a summary without recalculating. Returns null when the day has no activity yet. */
export async function readDailySummary(
  tx: TransactionClient,
  userId: string,
  date: string,
): Promise<DailySummaryRow | null> {
  const rows = await tx.query<RawSummaryRow>(
    `SELECT id, summary_date::text AS summary_date, calories_kcal, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, water_ml, workout_minutes, steps, sleep_minutes,
            meals_logged, revision
       FROM daily_summaries WHERE user_id = $1 AND summary_date = $2`,
    [userId, date],
  );
  const found = rows[0];
  return found ? normalizeSummary(found) : null;
}

/** A zeroed summary, for a day the user has not logged anything on. */
export function emptySummary(date: string): Omit<DailySummaryRow, 'id'> {
  return {
    summary_date: date,
    calories_kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
    sugar_g: 0,
    sodium_mg: 0,
    water_ml: 0,
    workout_minutes: 0,
    steps: 0,
    sleep_minutes: null,
    meals_logged: 0,
    revision: 0,
  };
}

/**
 * Recompute the rolling streak for a habit (spec §46).
 *
 * Deliberately reports a broken streak as a reset count with no negative framing — the
 * UI decides the copy, and the spec forbids guilt-inducing messaging.
 */
export async function recalculateStreak(
  tx: TransactionClient,
  userId: string,
  streakKey: 'food_logging' | 'workout' | 'water' | 'protein_goal' | 'weigh_in',
): Promise<{ currentCount: number; longestCount: number }> {
  const dateColumn = streakKey === 'weigh_in' ? 'logged_on' : 'logged_on';
  const table =
    streakKey === 'food_logging'
      ? 'daily_summaries'
      : streakKey === 'workout'
        ? 'workout_sessions'
        : streakKey === 'water'
          ? 'water_logs'
          : streakKey === 'weigh_in'
            ? 'weight_logs'
            : 'habit_logs';

  const condition =
    streakKey === 'food_logging'
      ? `meals_logged > 0`
      : streakKey === 'workout'
        ? `status = 'completed'`
        : streakKey === 'protein_goal'
          ? `habit_key = 'protein_goal' AND achieved`
          : `TRUE`;

  const rows = await tx.query<{ day: string }>(
    `SELECT DISTINCT ${streakKey === 'food_logging' ? 'summary_date' : dateColumn}::text AS day
       FROM ${table}
      WHERE user_id = $1 AND ${condition}
      ORDER BY day DESC
      LIMIT 400`,
    [userId],
  );

  const days = rows.map((r) => r.day);
  if (days.length === 0) {
    await upsertStreak(tx, userId, streakKey, 0, 0, null);
    return { currentCount: 0, longestCount: 0 };
  }

  let currentCount = 0;
  let longestCount = 0;
  let run = 0;
  let previous: Date | null = null;

  for (const day of days) {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (previous === null) {
      run = 1;
    } else {
      const deltaDays = Math.round((previous.getTime() - parsed.getTime()) / 86_400_000);
      run = deltaDays === 1 ? run + 1 : 1;
    }
    if (run > longestCount) longestCount = run;
    previous = parsed;
  }

  // The current streak only counts if the most recent logged day is today or yesterday.
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const last = new Date(`${days[0]}T00:00:00Z`);
  const gapFromToday = Math.round((todayUtc.getTime() - last.getTime()) / 86_400_000);

  if (gapFromToday <= 1) {
    currentCount = run;
  } else {
    currentCount = 0; // Streak ended earlier; reported without judgement.
  }

  await upsertStreak(
    tx,
    userId,
    streakKey,
    currentCount,
    Math.max(longestCount, currentCount),
    days[0] ?? null,
  );
  return { currentCount, longestCount: Math.max(longestCount, currentCount) };
}

async function upsertStreak(
  tx: TransactionClient,
  userId: string,
  streakKey: string,
  currentCount: number,
  longestCount: number,
  lastDate: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO user_streaks (user_id, streak_key, current_count, longest_count, last_date)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, streak_key) DO UPDATE SET
       current_count = EXCLUDED.current_count,
       longest_count = GREATEST(user_streaks.longest_count, EXCLUDED.longest_count),
       last_date     = EXCLUDED.last_date,
       updated_at    = now()`,
    [userId, streakKey, currentCount, longestCount, lastDate],
  );
}

/** Round helper re-exported so callers do not need two imports. */
export { round };
