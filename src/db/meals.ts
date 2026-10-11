/**
 * Meal logging service (spec §1, §7, §20, §21, §71, §87, §88, §130).
 *
 * This is the write path the whole product hangs off: log food, and the summary, streaks,
 * insights and every open dashboard must follow. It therefore:
 *  - runs as one real transaction (meal + items + summary commit together or not at all);
 *  - is idempotent, so a double tap cannot create two meals (§71);
 *  - always recomputes the summary from source rather than incrementing (§88, §130);
 *  - emits events only after the transaction commits, so a subscriber can never observe a
 *    meal that was subsequently rolled back.
 */

import { emitAfterCommit } from './emit';
import type { TransactionClient } from './client';
import { recalculateDailySummary, recalculateStreak } from './summaries';
import { computeNutrients, type NutrientValues } from '@/lib/nutrition';
import { approximateHouseholdGrams, round, type ServingDefinition } from '@/lib/units';

export type MealType = 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'pre_workout' | 'post_workout';

export interface MealItemInput {
  /** Food reference to resolve nutrition from. Required unless manual values are given. */
  readonly foodId?: string | null;
  readonly productId?: string | null;
  /** Free-text name as the user sees it. */
  readonly displayName?: string | null;
  readonly quantity: number;
  readonly unit: string;
  readonly servingId?: string | null;
  /** For correcting an existing item, or for a purely manual entry. */
  readonly manualValues?: NutrientValues | null;
  readonly scanResultId?: string | null;
}

export interface LogMealInput {
  readonly mealType: MealType;
  readonly mealDate: string;
  readonly title?: string | null;
  readonly notes?: string | null;
  readonly source?: string;
  readonly idempotencyKey?: string | null;
  readonly items: readonly MealItemInput[];
}

export interface LoggedMealItem {
  readonly id: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly unit: string;
  readonly grams: number;
  readonly nutrients: NutrientValues;
  readonly nutritionSource: string;
  readonly isApproximate: boolean;
  readonly explanation: string;
}

export interface LoggedMeal {
  readonly mealId: string;
  readonly mealType: MealType;
  readonly mealDate: string;
  readonly items: readonly LoggedMealItem[];
  readonly totals: NutrientValues;
  readonly summary: {
    readonly nutrients: NutrientValues;
    readonly waterMl: number;
    readonly workoutMinutes: number;
    readonly mealsLogged: number;
    readonly revision: number;
  };
  /** True when an existing meal was returned instead of a new one being created. */
  readonly deduplicated: boolean;
}

export class MealValidationError extends Error {
  readonly code = 'invalid_meal' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MealValidationError';
  }
}

/** A reference + servings pair, loaded for one food. */
interface FoodReference {
  readonly foodId: string;
  readonly canonicalName: string;
  readonly servings: ServingDefinition[];
  readonly reference: {
    id: string;
    basis_amount: number;
    basis_unit: 'g' | 'ml';
    calories_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    sugar_g: number;
    sodium_mg: number;
    source_name: string | null;
  } | null;
}

/**
 * Load the nutrition reference and serving definitions for a set of foods.
 * Returns an entry per requested id; `reference` is null when the food genuinely has no
 * stored nutrition, which the caller must surface rather than work around.
 */
async function loadReferences(
  tx: TransactionClient,
  foodIds: readonly string[],
): Promise<Map<string, FoodReference>> {
  const unique = [...new Set(foodIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const result = new Map<string, FoodReference>();
  if (unique.length === 0) return result;

  const foods = await tx.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM foods WHERE id = ANY($1::uuid[])`,
    [unique],
  );

  const servings = await tx.query<{
    id: string;
    food_id: string;
    label: string;
    unit: string;
    amount: string | number;
    grams: string | number;
    is_approximate: boolean;
  }>(
    `SELECT id, food_id, label, unit, amount, grams, is_approximate
       FROM food_servings WHERE food_id = ANY($1::uuid[])`,
    [unique],
  );

  // Prefer a verified reference; fall back to any stored row rather than inventing one.
  const references = await tx.query<{
    food_id: string;
    id: string;
    basis_amount: string | number;
    basis_unit: 'g' | 'ml';
    calories_kcal: string | number;
    protein_g: string | number;
    carbs_g: string | number;
    fat_g: string | number;
    fiber_g: string | number;
    sugar_g: string | number;
    sodium_mg: string | number;
    source_name: string | null;
    verified_at: string | null;
  }>(
    `SELECT DISTINCT ON (food_id)
            food_id, id, basis_amount, basis_unit, calories_kcal, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, source_name, verified_at::text AS verified_at
       FROM nutrition_reference
      WHERE food_id = ANY($1::uuid[])
      ORDER BY food_id, verified_at DESC NULLS LAST, created_at ASC`,
    [unique],
  );

  const referenceByFood = new Map(references.map((r) => [r.food_id, r]));
  const servingsByFood = new Map<string, ServingDefinition[]>();
  for (const s of servings) {
    const list = servingsByFood.get(s.food_id) ?? [];
    list.push({
      id: s.id,
      label: s.label,
      unit: s.unit,
      amount: Number(s.amount),
      grams: Number(s.grams),
      is_approximate: s.is_approximate,
    });
    servingsByFood.set(s.food_id, list);
  }

  for (const food of foods) {
    const ref = referenceByFood.get(food.id);
    result.set(food.id, {
      foodId: food.id,
      canonicalName: food.canonical_name,
      servings: servingsByFood.get(food.id) ?? [],
      reference: ref
        ? {
            id: ref.id,
            basis_amount: Number(ref.basis_amount),
            basis_unit: ref.basis_unit,
            calories_kcal: Number(ref.calories_kcal),
            protein_g: Number(ref.protein_g),
            carbs_g: Number(ref.carbs_g),
            fat_g: Number(ref.fat_g),
            fiber_g: Number(ref.fiber_g),
            sugar_g: Number(ref.sugar_g),
            sodium_mg: Number(ref.sodium_mg),
            source_name: ref.source_name,
          }
        : null,
    });
  }

  return result;
}

/**
 * Resolve one item into stored nutrient values.
 *
 * Order of resolution, and there is no fourth option:
 *  1. A referenced food with a stored nutrition row -> deterministic calculation.
 *  2. Explicit manual values from the user -> labelled `user_entered`.
 *  3. Nothing usable -> throw. We do not write a meal item with invented numbers.
 */
function resolveItem(
  item: MealItemInput,
  references: Map<string, FoodReference>,
): {
  values: NutrientValues;
  grams: number;
  displayName: string;
  source: string;
  isApproximate: boolean;
  explanation: string;
  servingId: string | null;
} {
  const food = item.foodId ? references.get(item.foodId) : undefined;

  if (food) {
    const computed = computeNutrients({
      quantity: item.quantity,
      unit: item.unit,
      servings: food.servings,
      reference: food.reference,
      source: 'database_record',
    });

    if (computed.ok) {
      return {
        values: {
          calories_kcal: computed.nutrients.calories_kcal,
          protein_g: computed.nutrients.protein_g,
          carbs_g: computed.nutrients.carbs_g,
          fat_g: computed.nutrients.fat_g,
          fiber_g: computed.nutrients.fiber_g,
          sugar_g: computed.nutrients.sugar_g,
          sodium_mg: computed.nutrients.sodium_mg,
        },
        grams: computed.nutrients.grams,
        displayName: item.displayName ?? food.canonicalName,
        source: 'database_record',
        isApproximate: computed.nutrients.isApproximate,
        explanation:
          `${computed.nutrients.explanation} ${computed.nutrients.isApproximate ? 'Portion is an estimate.' : ''}`.trim(),
        servingId: item.servingId ?? null,
      };
    }

    // A food exists but this quantity/unit cannot be resolved. If the user supplied
    // manual values we honour them; otherwise this is a genuine failure to surface.
    if (!item.manualValues) {
      throw new MealValidationError(
        `"${food.canonicalName}": ${computed.message} Provide an amount in grams, or pick a ` +
          `serving size defined for this food.`,
      );
    }
  }

  if (item.manualValues) {
    const values = item.manualValues;
    // A manual entry still needs a mass to store.
    //  1. Prefer the food's own declared serving weight, which is exact for that food.
    //  2. Else, for a household measure, use the explicitly-approximate equivalent. This
    //     is safe here because the user supplied the nutrient values: the gram figure is
    //     descriptive metadata for the logged item, not an input to nutrient arithmetic.
    //  3. Else ask the user for a weight rather than storing a fabricated number.
    let grams = 0;
    if (food && food.servings.length > 0) {
      const computed = computeNutrients({
        quantity: item.quantity,
        unit: item.unit,
        servings: food.servings,
        reference: null,
      });
      if (computed.ok) grams = computed.nutrients.grams;
    }
    if (grams <= 0) {
      grams = approximateHouseholdGrams(item.quantity, item.unit) ?? 0;
    }
    if (grams <= 0) {
      throw new MealValidationError(
        `Enter a weight in grams for "${item.displayName ?? 'this item'}" so it can be stored ` +
          `consistently, or pick a serving size that this food defines.`,
      );
    }

    return {
      values: {
        calories_kcal: round(values.calories_kcal, 2),
        protein_g: round(values.protein_g, 3),
        carbs_g: round(values.carbs_g, 3),
        fat_g: round(values.fat_g, 3),
        fiber_g: round(values.fiber_g, 3),
        sugar_g: round(values.sugar_g, 3),
        sodium_mg: round(values.sodium_mg, 2),
      },
      grams: round(grams, 3),
      displayName: item.displayName ?? 'Manual entry',
      source: 'user_entered',
      isApproximate: true,
      explanation: 'Values entered manually by the user; the weight shown is an estimate.',
      servingId: item.servingId ?? null,
    };
  }

  throw new MealValidationError(
    `No food reference and no manual values were supplied for one item, so its nutrition ` +
      `cannot be determined. The app will not guess values.`,
  );
}

/**
 * Create a meal, or return the existing one when the idempotency key was already used.
 * Must be called inside a user-scoped transaction so RLS applies to every statement.
 */
export async function logMeal(
  tx: TransactionClient,
  userId: string,
  input: LogMealInput,
): Promise<LoggedMeal> {
  if (input.items.length === 0) {
    throw new MealValidationError('A meal must contain at least one item.');
  }
  if (input.items.length > 50) {
    throw new MealValidationError('A meal cannot contain more than 50 items.');
  }

  // Idempotency: a retried request returns the original meal rather than creating another.
  if (input.idempotencyKey) {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM meals WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, input.idempotencyKey],
    );
    const existingId = existing[0]?.id;
    if (existingId) {
      return readMeal(tx, userId, existingId, true);
    }
  }

  const foodIds = input.items
    .map((i) => i.foodId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const references = await loadReferences(tx, foodIds);

  const resolved = input.items.map((item) => resolveItem(item, references));

  const mealRows = await tx.query<{ id: string }>(
    `INSERT INTO meals (user_id, meal_type, meal_date, title, notes, source, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      userId,
      input.mealType,
      input.mealDate,
      input.title ?? null,
      input.notes ?? null,
      input.source ?? 'manual',
      input.idempotencyKey ?? null,
    ],
  );
  const mealId = mealRows[0]?.id;
  if (!mealId) throw new Error('Failed to create the meal row.');

  const storedItems: LoggedMealItem[] = [];

  for (const [index, item] of input.items.entries()) {
    const r = resolved[index]!;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO meal_items
         (meal_id, position, food_id, product_id, display_name, quantity, unit, grams, serving_id,
          calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
          nutrition_source, scan_result_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        mealId,
        index,
        item.foodId ?? null,
        item.productId ?? null,
        r.displayName,
        item.quantity,
        item.unit,
        r.grams,
        r.servingId,
        r.values.calories_kcal,
        r.values.protein_g,
        r.values.carbs_g,
        r.values.fat_g,
        r.values.fiber_g,
        r.values.sugar_g,
        r.values.sodium_mg,
        r.source,
        item.scanResultId ?? null,
      ],
    );

    storedItems.push({
      id: inserted[0]?.id ?? '',
      displayName: r.displayName,
      quantity: item.quantity,
      unit: item.unit,
      grams: r.grams,
      nutrients: r.values,
      nutritionSource: r.source,
      isApproximate: r.isApproximate,
      explanation: r.explanation,
    });
  }

  // Derived state is recomputed, never incremented.
  const summary = await recalculateDailySummary(tx, userId, input.mealDate);
  await recalculateStreak(tx, userId, 'food_logging');

  const totals = resolved.reduce<NutrientValues>(
    (acc, r) => ({
      calories_kcal: round(acc.calories_kcal + r.values.calories_kcal, 2),
      protein_g: round(acc.protein_g + r.values.protein_g, 3),
      carbs_g: round(acc.carbs_g + r.values.carbs_g, 3),
      fat_g: round(acc.fat_g + r.values.fat_g, 3),
      fiber_g: round(acc.fiber_g + r.values.fiber_g, 3),
      sugar_g: round(acc.sugar_g + r.values.sugar_g, 3),
      sodium_mg: round(acc.sodium_mg + r.values.sodium_mg, 2),
    }),
    {
      calories_kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
      sugar_g: 0,
      sodium_mg: 0,
    },
  );

  // Emitted only after commit, so no subscriber sees a rolled-back meal.
  emitAfterCommit({
    type: 'meal.created',
    userId,
    payload: {
      mealId,
      mealType: input.mealType,
      mealDate: input.mealDate,
      itemCount: storedItems.length,
      totalCalories: totals.calories_kcal,
    },
  });
  emitAfterCommit({
    type: 'summary.updated',
    userId,
    payload: {
      date: summary.summary_date,
      revision: summary.revision,
      nutrients: {
        calories_kcal: summary.calories_kcal,
        protein_g: summary.protein_g,
        carbs_g: summary.carbs_g,
        fat_g: summary.fat_g,
        fiber_g: summary.fiber_g,
        sugar_g: summary.sugar_g,
        sodium_mg: summary.sodium_mg,
      },
      waterMl: summary.water_ml,
      workoutMinutes: summary.workout_minutes,
      mealsLogged: summary.meals_logged,
    },
  });

  return {
    mealId,
    mealType: input.mealType,
    mealDate: input.mealDate,
    items: storedItems,
    totals,
    summary: {
      nutrients: {
        calories_kcal: summary.calories_kcal,
        protein_g: summary.protein_g,
        carbs_g: summary.carbs_g,
        fat_g: summary.fat_g,
        fiber_g: summary.fiber_g,
        sugar_g: summary.sugar_g,
        sodium_mg: summary.sodium_mg,
      },
      waterMl: summary.water_ml,
      workoutMinutes: summary.workout_minutes,
      mealsLogged: summary.meals_logged,
      revision: summary.revision,
    },
    deduplicated: false,
  };
}

/** Read a stored meal with its items. */
export async function readMeal(
  tx: TransactionClient,
  userId: string,
  mealId: string,
  deduplicated = false,
): Promise<LoggedMeal> {
  const meals = await tx.query<{
    id: string;
    meal_type: MealType;
    meal_date: string;
  }>(
    `SELECT id, meal_type, meal_date::text AS meal_date
       FROM meals WHERE id = $1 AND user_id = $2`,
    [mealId, userId],
  );
  const meal = meals[0];
  if (!meal) throw new MealValidationError('That meal does not exist.');

  const items = await tx.query<{
    id: string;
    display_name: string;
    quantity: string | number;
    unit: string;
    grams: string | number;
    calories_kcal: string | number;
    protein_g: string | number;
    carbs_g: string | number;
    fat_g: string | number;
    fiber_g: string | number;
    sugar_g: string | number;
    sodium_mg: string | number;
    nutrition_source: string;
  }>(
    `SELECT id, display_name, quantity, unit, grams, calories_kcal, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, nutrition_source
       FROM meal_items WHERE meal_id = $1 ORDER BY position`,
    [mealId],
  );

  const mapped: LoggedMealItem[] = items.map((i) => ({
    id: i.id,
    displayName: i.display_name,
    quantity: Number(i.quantity),
    unit: i.unit,
    grams: Number(i.grams),
    nutrients: {
      calories_kcal: Number(i.calories_kcal),
      protein_g: Number(i.protein_g),
      carbs_g: Number(i.carbs_g),
      fat_g: Number(i.fat_g),
      fiber_g: Number(i.fiber_g),
      sugar_g: Number(i.sugar_g),
      sodium_mg: Number(i.sodium_mg),
    },
    nutritionSource: i.nutrition_source,
    isApproximate: i.nutrition_source !== 'user_entered',
    explanation: 'Stored values as previously confirmed.',
  }));

  const totals = mapped.reduce<NutrientValues>(
    (acc, i) => ({
      calories_kcal: round(acc.calories_kcal + i.nutrients.calories_kcal, 2),
      protein_g: round(acc.protein_g + i.nutrients.protein_g, 3),
      carbs_g: round(acc.carbs_g + i.nutrients.carbs_g, 3),
      fat_g: round(acc.fat_g + i.nutrients.fat_g, 3),
      fiber_g: round(acc.fiber_g + i.nutrients.fiber_g, 3),
      sugar_g: round(acc.sugar_g + i.nutrients.sugar_g, 3),
      sodium_mg: round(acc.sodium_mg + i.nutrients.sodium_mg, 2),
    }),
    { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 },
  );

  const summary = await recalculateDailySummary(tx, userId, meal.meal_date);

  return {
    mealId: meal.id,
    mealType: meal.meal_type,
    mealDate: meal.meal_date,
    items: mapped,
    totals,
    summary: {
      nutrients: {
        calories_kcal: summary.calories_kcal,
        protein_g: summary.protein_g,
        carbs_g: summary.carbs_g,
        fat_g: summary.fat_g,
        fiber_g: summary.fiber_g,
        sugar_g: summary.sugar_g,
        sodium_mg: summary.sodium_mg,
      },
      waterMl: summary.water_ml,
      workoutMinutes: summary.workout_minutes,
      mealsLogged: summary.meals_logged,
      revision: summary.revision,
    },
    deduplicated,
  };
}

/** Update one item's quantity, recalculating nutrition without another AI call (spec §7). */
export async function updateMealItemQuantity(
  tx: TransactionClient,
  userId: string,
  mealId: string,
  itemId: string,
  quantity: number,
  unit: string,
): Promise<LoggedMeal> {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new MealValidationError('Quantity must be a positive number.');
  }

  const rows = await tx.query<{ food_id: string | null; meal_date: string }>(
    `SELECT mi.food_id, m.meal_date::text AS meal_date
       FROM meal_items mi
       JOIN meals m ON m.id = mi.meal_id
      WHERE mi.id = $1 AND mi.meal_id = $2 AND m.user_id = $3`,
    [itemId, mealId, userId],
  );
  const row = rows[0];
  if (!row) throw new MealValidationError('That meal item does not exist.');

  const references = await loadReferences(tx, row.food_id ? [row.food_id] : []);

  const food = row.food_id ? references.get(row.food_id) : undefined;
  if (!food) {
    throw new MealValidationError(
      'This item has no linked food reference, so its quantity cannot be recalculated. ' +
        'Edit the values manually instead.',
    );
  }

  const computed = computeNutrients({
    quantity,
    unit,
    servings: food.servings,
    reference: food.reference,
    source: 'database_record',
  });
  if (!computed.ok) {
    throw new MealValidationError(computed.message);
  }

  await tx.query(
    `UPDATE meal_items SET
       quantity = $1, unit = $2, grams = $3,
       calories_kcal = $4, protein_g = $5, carbs_g = $6, fat_g = $7,
       fiber_g = $8, sugar_g = $9, sodium_mg = $10,
       nutrition_source = 'database_record'
     WHERE id = $11`,
    [
      quantity,
      unit,
      computed.nutrients.grams,
      computed.nutrients.calories_kcal,
      computed.nutrients.protein_g,
      computed.nutrients.carbs_g,
      computed.nutrients.fat_g,
      computed.nutrients.fiber_g,
      computed.nutrients.sugar_g,
      computed.nutrients.sodium_mg,
      itemId,
    ],
  );

  const result = await readMeal(tx, userId, mealId);

  emitAfterCommit({
    type: 'meal.updated',
    userId,
    payload: { mealId, itemId, quantity, unit, mealDate: row.meal_date },
  });
  emitAfterCommit({
    type: 'summary.updated',
    userId,
    payload: {
      date: row.meal_date,
      revision: result.summary.revision,
      nutrients: result.summary.nutrients,
    },
  });

  return result;
}

/** Delete a meal and recompute the day (spec §130 — no stale totals left behind). */
export async function deleteMeal(
  tx: TransactionClient,
  userId: string,
  mealId: string,
): Promise<{ mealDate: string; summary: LoggedMeal['summary'] }> {
  const rows = await tx.query<{ meal_date: string }>(
    `DELETE FROM meals WHERE id = $1 AND user_id = $2 RETURNING meal_date::text AS meal_date`,
    [mealId, userId],
  );
  const deleted = rows[0];
  if (!deleted) throw new MealValidationError('That meal does not exist.');

  const summary = await recalculateDailySummary(tx, userId, deleted.meal_date);
  await recalculateStreak(tx, userId, 'food_logging');

  emitAfterCommit({
    type: 'meal.deleted',
    userId,
    payload: { mealId, mealDate: deleted.meal_date },
  });
  emitAfterCommit({
    type: 'summary.updated',
    userId,
    payload: {
      date: summary.summary_date,
      revision: summary.revision,
      nutrients: {
        calories_kcal: summary.calories_kcal,
        protein_g: summary.protein_g,
        carbs_g: summary.carbs_g,
        fat_g: summary.fat_g,
        fiber_g: summary.fiber_g,
        sugar_g: summary.sugar_g,
        sodium_mg: summary.sodium_mg,
      },
      waterMl: summary.water_ml,
      workoutMinutes: summary.workout_minutes,
      mealsLogged: summary.meals_logged,
    },
  });

  return {
    mealDate: deleted.meal_date,
    summary: {
      nutrients: {
        calories_kcal: summary.calories_kcal,
        protein_g: summary.protein_g,
        carbs_g: summary.carbs_g,
        fat_g: summary.fat_g,
        fiber_g: summary.fiber_g,
        sugar_g: summary.sugar_g,
        sodium_mg: summary.sodium_mg,
      },
      waterMl: summary.water_ml,
      workoutMinutes: summary.workout_minutes,
      mealsLogged: summary.meals_logged,
      revision: summary.revision,
    },
  };
}
