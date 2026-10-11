/**
 * End-to-end meal logging and realtime tests (spec §1, §7, §71, §87, §88, §89, §90, §130).
 *
 * These exercise the real write path against real PostgreSQL: log a meal, watch the
 * summary recompute, correct a quantity, delete it, and confirm the realtime events and
 * idempotency behave as the spec requires.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tempDir: string;
let userId: string;
let foodIds: Record<string, string> = {};

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'fittrack-meals-'));
  process.env.PGLITE_DATA_DIR = tempDir;
  process.env.APP_ENV = 'development';

  const { migrate } = await import('@/db/migrate');
  await migrate();

  const { transaction } = await import('@/db/client');

  // Seed a minimal but real reference set: a food, its servings and its nutrition row.
  await transaction(async (tx) => {
    const cat = await tx.query<{ id: string }>(
      `INSERT INTO food_categories (slug, name) VALUES ('rice_dishes','Rice dishes') RETURNING id`,
    );
    const categoryId = cat[0]!.id;

    const foods: [string, string, string, string, number, number, number, number, number][] = [
      // name, region, servingLabel, servingUnit, servingGrams, kcal, protein, carbs, fat
      ['Cooked Rice', 'south_indian', '1 katori', 'katori', 150, 130, 2.7, 28.2, 0.3],
      ['Idli', 'south_indian', '1 idli', 'piece', 45, 132, 4.6, 26.4, 0.4],
      ['Sambar', 'south_indian', '1 katori', 'katori', 150, 55, 3.1, 8.2, 1.4],
      ['Boiled Egg', 'indian_general', '1 piece', 'piece', 50, 155, 13, 1.1, 11],
    ];

    const created: Record<string, string> = {};

    for (const [
      name,
      region,
      servingLabel,
      servingUnit,
      servingGrams,
      kcal,
      protein,
      carbs,
      fat,
    ] of foods) {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO foods (canonical_name, normalized_name, category_id, region, is_verified)
         VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [name, name.toLowerCase(), categoryId, region],
      );
      const foodId = rows[0]!.id;
      created[name] = foodId;

      await tx.query(
        `INSERT INTO food_servings (food_id, label, unit, amount, grams, is_approximate, is_default)
         VALUES ($1,$2,$3,1,$4,true,true)`,
        [foodId, servingLabel, servingUnit, servingGrams],
      );

      // Values stated per 100 g, as the engine requires.
      const per100 = {
        kcal: (kcal / servingGrams) * 100,
        protein: (protein / servingGrams) * 100,
        carbs: (carbs / servingGrams) * 100,
        fat: (fat / servingGrams) * 100,
      };

      await tx.query(
        `INSERT INTO nutrition_reference
           (food_id, basis_amount, basis_unit, calories_kcal, protein_g, carbs_g, fat_g,
            fiber_g, sugar_g, sodium_mg, source, source_name, verified_at)
         VALUES ($1,100,'g',$2,$3,$4,$5,0.5,0.2,5,'database_record','Test reference', now())`,
        [
          foodId,
          Number(per100.kcal.toFixed(2)),
          Number(per100.protein.toFixed(3)),
          Number(per100.carbs.toFixed(3)),
          Number(per100.fat.toFixed(3)),
        ],
      );
    }

    const user = await tx.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, display_name) VALUES ('meal-tester@example.test','x','Tester') RETURNING id`,
    );
    userId = user[0]!.id;
    foodIds = created;
  });
}, 60_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/client');
  await closeDb();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('logging a meal', () => {
  it('computes nutrition from the reference and updates the summary in one transaction', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');

    const result = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'lunch',
        mealDate: today(),
        title: 'Rice and sambar',
        idempotencyKey: 'test-meal-1',
        items: [
          { foodId: foodIds['Cooked Rice'], quantity: 1, unit: 'katori' },
          { foodId: foodIds['Sambar'], quantity: 1, unit: 'katori' },
        ],
      }),
    );

    expect(result.deduplicated).toBe(false);
    expect(result.items).toHaveLength(2);
    // The seed defines "1 katori (150 g) of cooked rice = 130 kcal", so one katori is
    // 130 kcal and the reference row holds 86.667 kcal per 100 g.
    expect(result.items[0]!.nutrients.calories_kcal).toBeCloseTo(130, 1);
    expect(result.items[0]!.grams).toBe(150);
    // Sambar is seeded at 55 kcal per 150 g katori, so the two items total 185 kcal.
    expect(result.totals.calories_kcal).toBeCloseTo(130 + 55, 0);
    expect(result.summary.mealsLogged).toBe(1);
    expect(result.summary.nutrients.calories_kcal).toBeCloseTo(result.totals.calories_kcal, 1);
    expect(result.summary.revision).toBe(1);
  });

  it('is idempotent: a double submit returns the original meal', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');
    const { transaction } = await import('@/db/client');

    const before = await transaction(async (tx) => {
      const r = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM meals WHERE user_id = $1`,
        [userId],
      );
      return r[0]!.n;
    });

    const result = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'lunch',
        mealDate: today(),
        title: 'Rice and sambar',
        idempotencyKey: 'test-meal-1',
        items: [
          { foodId: foodIds['Cooked Rice'], quantity: 1, unit: 'katori' },
          { foodId: foodIds['Sambar'], quantity: 1, unit: 'katori' },
        ],
      }),
    );

    expect(result.deduplicated).toBe(true);

    const after = await transaction(async (tx) => {
      const r = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM meals WHERE user_id = $1`,
        [userId],
      );
      return r[0]!.n;
    });
    expect(after).toBe(before);
  });

  it('REFUSES to store an item whose unit cannot be resolved to grams', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal, MealValidationError } = await import('@/db/meals');

    await expect(
      withUserTransaction({ userId, role: 'user' }, (tx) =>
        logMeal(tx, userId, {
          mealType: 'snack',
          mealDate: today(),
          items: [
            // Boiled Egg declares no 'bowl' serving, so this must fail rather than guess.
            { foodId: foodIds['Boiled Egg'], quantity: 2, unit: 'bowl' },
          ],
        }),
      ),
    ).rejects.toThrow(MealValidationError);

    await expect(
      withUserTransaction({ userId, role: 'user' }, (tx) =>
        logMeal(tx, userId, {
          mealType: 'snack',
          mealDate: today(),
          items: [{ foodId: foodIds['Boiled Egg'], quantity: 2, unit: 'bowl' }],
        }),
      ),
    ).rejects.toThrow(/could not be|cannot be|not defined|No serving|defines no/i);
  });

  it('stores a manual entry when the user supplies their own values', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');

    const result = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'snack',
        mealDate: today(),
        title: 'Homemade smoothie',
        items: [
          {
            displayName: 'Homemade smoothie',
            quantity: 1,
            unit: 'glass',
            manualValues: {
              calories_kcal: 210,
              protein_g: 8,
              carbs_g: 30,
              fat_g: 6,
              fiber_g: 3,
              sugar_g: 18,
              sodium_mg: 90,
            },
          },
        ],
      }),
    );

    expect(result.items[0]!.nutritionSource).toBe('user_entered');
    expect(result.totals.calories_kcal).toBe(210);
  });

  it('labels provenance on every item (spec §69, §70)', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');

    const result = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'breakfast',
        mealDate: today(),
        items: [{ foodId: foodIds['Idli'], quantity: 2, unit: 'piece' }],
      }),
    );

    const item = result.items[0]!;
    expect(item.nutritionSource).toBe('database_record');
    expect(item.explanation).toMatch(/stored reference values/i);
    expect(item.grams).toBe(90);
    // The seed states idli at 132 kcal per 45 g piece, so 2 pieces (90 g) = 264 kcal.
    expect(item.nutrients.calories_kcal).toBeCloseTo(264, 1);
  });
});

describe('correcting a quantity recalculates without another AI call', () => {
  it('recomputes nutrition and bumps the summary revision', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal, updateMealItemQuantity } = await import('@/db/meals');

    const logged = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'dinner',
        mealDate: today(),
        items: [{ foodId: foodIds['Cooked Rice'], quantity: 1, unit: 'katori' }],
      }),
    );

    const beforeCalories = logged.items[0]!.nutrients.calories_kcal;
    const revisionBefore = logged.summary.revision;

    const corrected = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      updateMealItemQuantity(tx, userId, logged.mealId, logged.items[0]!.id, 220, 'g'),
    );

    expect(corrected.items[0]!.grams).toBe(220);
    // The food row declares 1 katori = 150 g, so 220 g is 220/150 = 1.4667 katori.
    // Its stored nutrition is 86.667 kcal per 100 g, giving 190.67 kcal for 220 g.
    // The arithmetic below is derived independently, not copied from the implementation.
    const per100g = (130 / 150) * 100;
    expect(corrected.items[0]!.nutrients.calories_kcal).toBeCloseTo((per100g * 220) / 100, 1);
    expect(corrected.items[0]!.nutrients.calories_kcal).toBeGreaterThan(beforeCalories);
    expect(corrected.summary.revision).toBeGreaterThan(revisionBefore);
  });
});

describe('deleting a meal leaves no stale totals', () => {
  it('recomputes the summary from scratch', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal, deleteMeal } = await import('@/db/meals');

    const logged = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'snack',
        mealDate: today(),
        items: [{ foodId: foodIds['Boiled Egg'], quantity: 2, unit: 'piece' }],
      }),
    );
    const withSnack = logged.summary.nutrients.calories_kcal;

    const afterDelete = await withUserTransaction({ userId, role: 'user' }, (tx) =>
      deleteMeal(tx, userId, logged.mealId),
    );

    expect(afterDelete.summary.nutrients.calories_kcal).toBeLessThan(withSnack);
    expect(afterDelete.summary.nutrients.calories_kcal).toBeCloseTo(
      withSnack - logged.totals.calories_kcal,
      1,
    );
    // The API must hand back real numbers, not the driver's numeric strings.
    expect(typeof afterDelete.summary.nutrients.calories_kcal).toBe('number');
    expect(typeof afterDelete.summary.revision).toBe('number');
  });
});

describe('realtime events', () => {
  it('publishes meal and summary events to the owner only', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');
    const { subscribe } = await import('@/lib/events');
    const { transaction } = await import('@/db/client');

    const other = await transaction(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO profiles (email, password_hash, display_name) VALUES ('bystander@example.test','x','Bystander') RETURNING id`,
      );
      return r[0]!.id;
    });

    const received: string[] = [];
    const otherReceived: string[] = [];
    const unsubscribe = subscribe(userId, (e) => received.push(e.type));
    const unsubscribeOther = subscribe(other, (e) => otherReceived.push(e.type));

    await withUserTransaction({ userId, role: 'user' }, (tx) =>
      logMeal(tx, userId, {
        mealType: 'lunch',
        mealDate: today(),
        items: [{ foodId: foodIds['Idli'], quantity: 1, unit: 'piece' }],
      }),
    );

    unsubscribe();
    unsubscribeOther();

    expect(received).toContain('meal.created');
    expect(received).toContain('summary.updated');
    // The other user's stream must not see anything.
    expect(otherReceived).toEqual([]);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM profiles WHERE id = $1`, [other]);
    });
  });

  it('publishes NOTHING when the transaction rolls back', async () => {
    const { withUserTransaction } = await import('@/db/operations');
    const { logMeal } = await import('@/db/meals');
    const { subscribe } = await import('@/lib/events');

    const received: string[] = [];
    const unsubscribe = subscribe(userId, (e) => received.push(e.type));

    await expect(
      withUserTransaction({ userId, role: 'user' }, async (tx) => {
        await logMeal(tx, userId, {
          mealType: 'lunch',
          mealDate: today(),
          items: [{ foodId: foodIds['Idli'], quantity: 1, unit: 'piece' }],
        });
        // Force a rollback after the meal was written.
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    unsubscribe();
    expect(received).toEqual([]);
  });

  it('refuses to emit outside a transaction scope', async () => {
    const { emitAfterCommit } = await import('@/db/emit');
    expect(() => emitAfterCommit({ type: 'meal.created', userId, payload: {} })).toThrow(
      /outside a transaction scope/i,
    );
  });
});
