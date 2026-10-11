/**
 * Seed loader (spec §104).
 *
 * Loads the curated food, serving, nutrient-reference and exercise data into a real
 * database. Two properties matter:
 *
 *  - **Idempotent.** Running it twice changes nothing. Every row is keyed on a natural
 *    identifier (canonical name, category slug, alias, exercise slug) and upserted, so it
 *    is safe to run against an existing development database.
 *  - **No fake users.** Only reference data is seeded. It never creates demo accounts or
 *    production-looking user rows. A separate, explicit flag creates a local test account.
 */

import type { TransactionClient } from './client';
import { foodCategories, seedFoods } from './seed-data/foods';
import { seedExercises } from './seed-data/exercises';

export interface SeedReport {
  readonly categories: number;
  readonly foods: number;
  readonly servings: number;
  readonly aliases: number;
  readonly nutritionReferences: number;
  readonly exercises: number;
  readonly skippedFoods: string[];
}

/**
 * Validate a seed food's internal consistency before it reaches the database.
 * The calorie/macro sanity rule is enforced by a CHECK constraint too; catching it here
 * names the offending food instead of failing with a constraint error.
 */
function assertFoodConsistent(food: (typeof seedFoods)[number]): void {
  const { caloriesKcal, proteinG, carbsG, fatG } = food.per100g;
  const derived = (carbsG + proteinG) * 4 + fatG * 9 + 40;
  if (caloriesKcal > derived) {
    throw new Error(
      `Seed food "${food.canonicalName}" is not physically plausible: ${caloriesKcal} kcal/100 g ` +
        `exceeds the maximum ${derived.toFixed(1)} kcal implied by its macros ` +
        `(P ${proteinG} / C ${carbsG} / F ${fatG}). Likely a raw-vs-cooked mix-up.`,
    );
  }
  const defaults = food.servings.filter((s) => s.isDefault);
  if (defaults.length !== 1) {
    throw new Error(
      `Seed food "${food.canonicalName}" must have exactly one default serving, found ${defaults.length}.`,
    );
  }
  for (const serving of food.servings) {
    if (!(serving.amount > 0) || !(serving.grams > 0)) {
      throw new Error(
        `Seed food "${food.canonicalName}" has a serving "${serving.label}" with a non-positive amount or weight.`,
      );
    }
  }
}

/** Insert or update the shared reference data. Safe to run repeatedly. */
export async function seedReferenceData(tx: TransactionClient): Promise<SeedReport> {
  for (const food of seedFoods) assertFoodConsistent(food);

  // ---- categories ------------------------------------------------------------------
  const categoryIds = new Map<string, string>();
  for (const category of foodCategories) {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO food_categories (slug, name, sort_order)
       VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [category.slug, category.name, category.sortOrder],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`Failed to upsert food category "${category.slug}".`);
    categoryIds.set(category.slug, id);
  }

  // ---- foods, servings, aliases, nutrition -----------------------------------------
  let servings = 0;
  let aliases = 0;
  let references = 0;
  const skipped: string[] = [];

  for (const food of seedFoods) {
    const categoryId = categoryIds.get(food.categorySlug);
    if (!categoryId) {
      throw new Error(
        `Seed food "${food.canonicalName}" references unknown category "${food.categorySlug}".`,
      );
    }

    const foodRows = await tx.query<{ id: string }>(
      `INSERT INTO foods (canonical_name, normalized_name, category_id, region, description, is_verified, verification_note)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       ON CONFLICT (lower(canonical_name)) DO UPDATE SET
         normalized_name  = EXCLUDED.normalized_name,
         category_id      = EXCLUDED.category_id,
         region           = EXCLUDED.region,
         description      = EXCLUDED.description,
         is_verified      = EXCLUDED.is_verified,
         verification_note = EXCLUDED.verification_note
       RETURNING id`,
      [
        food.canonicalName,
        food.canonicalName.toLowerCase(),
        categoryId,
        food.region,
        food.preparationNote,
        food.sourceName,
      ],
    );
    const foodId = foodRows[0]?.id;
    if (!foodId) throw new Error(`Failed to upsert food "${food.canonicalName}".`);

    // Servings. The existing defaults are cleared first so the unique "one default per
    // food" index cannot be violated while re-seeding.
    await tx.query(`UPDATE food_servings SET is_default = false WHERE food_id = $1`, [foodId]);

    for (const serving of food.servings) {
      await tx.query(
        `INSERT INTO food_servings (food_id, label, unit, amount, grams, is_approximate, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (food_id, lower(label)) DO UPDATE SET
           unit = EXCLUDED.unit,
           amount = EXCLUDED.amount,
           grams = EXCLUDED.grams,
           is_approximate = EXCLUDED.is_approximate,
           is_default = EXCLUDED.is_default`,
        [
          foodId,
          serving.label,
          serving.unit,
          serving.amount,
          serving.grams,
          serving.isApproximate,
          serving.isDefault ?? false,
        ],
      );
      servings += 1;
    }

    // Point the food at its default serving.
    const defaultServing = await tx.query<{ id: string }>(
      `SELECT id FROM food_servings WHERE food_id = $1 AND is_default LIMIT 1`,
      [foodId],
    );
    if (defaultServing[0]?.id) {
      await tx.query(`UPDATE foods SET default_serving_id = $2 WHERE id = $1`, [
        foodId,
        defaultServing[0].id,
      ]);
    }

    // Aliases, including the canonical name so exact search always resolves.
    const aliasRows: { alias: string; language: string; region: string | null }[] = [
      { alias: food.canonicalName, language: 'en', region: food.region },
      ...food.aliases.map((a) => ({
        alias: a.alias,
        language: a.language ?? 'en',
        region: a.region ?? null,
      })),
    ];
    const seenAlias = new Set<string>();
    for (const alias of aliasRows) {
      const key = `${alias.alias.toLowerCase()}|${alias.language}`;
      if (seenAlias.has(key)) continue;
      seenAlias.add(key);

      await tx.query(
        `INSERT INTO food_aliases (food_id, alias, normalized_alias, language, region)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (food_id, lower(alias), language) DO UPDATE SET
           normalized_alias = EXCLUDED.normalized_alias,
           region = EXCLUDED.region`,
        [foodId, alias.alias, alias.alias.toLowerCase(), alias.language, alias.region],
      );
      aliases += 1;
    }

    // Nutrition reference, stored per 100 g of the edible portion as the engine requires.
    await tx.query(
      `INSERT INTO nutrition_reference
         (food_id, basis_amount, basis_unit, calories_kcal, protein_g, carbs_g, fat_g,
          fiber_g, sugar_g, sodium_mg, source, source_name, source_url, verified_at)
       VALUES ($1,100,'g',$2,$3,$4,$5,$6,$7,$8,'database_record',$9,$10, now())
       ON CONFLICT (food_id, COALESCE(cooking_method,''), COALESCE(source_ref,'')) DO UPDATE SET
         calories_kcal = EXCLUDED.calories_kcal,
         protein_g     = EXCLUDED.protein_g,
         carbs_g       = EXCLUDED.carbs_g,
         fat_g         = EXCLUDED.fat_g,
         fiber_g       = EXCLUDED.fiber_g,
         sugar_g       = EXCLUDED.sugar_g,
         sodium_mg     = EXCLUDED.sodium_mg,
         source_name   = EXCLUDED.source_name,
         source_url    = EXCLUDED.source_url,
         verified_at   = EXCLUDED.verified_at`,
      [
        foodId,
        food.per100g.caloriesKcal,
        food.per100g.proteinG,
        food.per100g.carbsG,
        food.per100g.fatG,
        food.per100g.fiberG,
        food.per100g.sugarG,
        food.per100g.sodiumMg,
        food.sourceName,
        food.sourceUrl ?? null,
      ],
    );
    references += 1;
  }

  // ---- exercises -------------------------------------------------------------------
  for (const exercise of seedExercises) {
    await tx.query(
      `INSERT INTO exercises
         (slug, name, category, primary_muscles, secondary_muscles, equipment, difficulty,
          instructions, safety_notes, is_timed, is_unilateral, met_value, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,true)
       ON CONFLICT (slug) DO UPDATE SET
         name              = EXCLUDED.name,
         category          = EXCLUDED.category,
         primary_muscles   = EXCLUDED.primary_muscles,
         secondary_muscles = EXCLUDED.secondary_muscles,
         equipment         = EXCLUDED.equipment,
         difficulty        = EXCLUDED.difficulty,
         instructions      = EXCLUDED.instructions,
         safety_notes      = EXCLUDED.safety_notes,
         is_timed          = EXCLUDED.is_timed,
         is_unilateral     = EXCLUDED.is_unilateral,
         met_value         = EXCLUDED.met_value,
         is_verified       = EXCLUDED.is_verified`,
      [
        exercise.slug,
        exercise.name,
        exercise.category,
        exercise.primaryMuscles,
        exercise.secondaryMuscles,
        exercise.equipment,
        exercise.difficulty,
        JSON.stringify(exercise.instructions),
        exercise.safetyNotes,
        exercise.isTimed,
        exercise.isUnilateral,
        exercise.metValue ?? null,
      ],
    );
  }

  // ---- achievements (needed by the achievement engine) ------------------------------
  const achievements: {
    slug: string;
    name: string;
    description: string;
    category: string;
    threshold: number;
    metric: string;
  }[] = [
    {
      slug: 'first_scan',
      name: 'First Scan',
      description: 'Analysed your first food photo.',
      category: 'scanning',
      threshold: 1,
      metric: 'scans',
    },
    {
      slug: 'first_meal',
      name: 'First Meal Logged',
      description: 'Logged your first meal.',
      category: 'nutrition',
      threshold: 1,
      metric: 'meals',
    },
    {
      slug: 'meals_100',
      name: '100 Meals Logged',
      description: 'Logged 100 meals.',
      category: 'nutrition',
      threshold: 100,
      metric: 'meals',
    },
    {
      slug: 'meals_500',
      name: '500 Meals Logged',
      description: 'Logged 500 meals.',
      category: 'nutrition',
      threshold: 500,
      metric: 'meals',
    },
    {
      slug: 'first_workout',
      name: 'First Workout',
      description: 'Completed your first workout.',
      category: 'training',
      threshold: 1,
      metric: 'workouts',
    },
    {
      slug: 'workouts_50',
      name: '50 Workouts',
      description: 'Completed 50 workouts.',
      category: 'training',
      threshold: 50,
      metric: 'workouts',
    },
    {
      slug: 'streak_7',
      name: '7 Day Streak',
      description: 'Logged food 7 days in a row.',
      category: 'consistency',
      threshold: 7,
      metric: 'food_logging_streak',
    },
    {
      slug: 'streak_30',
      name: '30 Day Streak',
      description: 'Logged food 30 days in a row.',
      category: 'consistency',
      threshold: 30,
      metric: 'food_logging_streak',
    },
    {
      slug: 'protein_goal',
      name: 'Protein Goal Completed',
      description: 'Hit your protein target for a day.',
      category: 'nutrition',
      threshold: 1,
      metric: 'protein_goal_days',
    },
    {
      slug: 'water_goal',
      name: 'Hydration Goal',
      description: 'Reached your water target for a day.',
      category: 'hydration',
      threshold: 1,
      metric: 'water_goal_days',
    },
    {
      slug: 'weigh_in_10',
      name: 'Ten Check-ins',
      description: 'Recorded your weight 10 times.',
      category: 'progress',
      threshold: 10,
      metric: 'weight_logs',
    },
    {
      slug: 'first_plan',
      name: 'Planner',
      description: 'Generated your first meal plan.',
      category: 'planning',
      threshold: 1,
      metric: 'meal_plans',
    },
  ];

  for (const a of achievements) {
    await tx.query(
      `INSERT INTO achievements (slug, name, description, category, threshold, metric)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         category = EXCLUDED.category, threshold = EXCLUDED.threshold, metric = EXCLUDED.metric`,
      [a.slug, a.name, a.description, a.category, a.threshold, a.metric],
    );
  }

  // ---- subscription plans (prices are zero until a payment provider is configured) ---
  const plans = [
    {
      code: 'free',
      name: 'Free',
      description: 'Basic logging, dashboard, weight and water tracking.',
      priceMinor: 0,
      period: 'none',
      entitlements: {
        aiScansPerDay: 3,
        aiChatPerDay: 0,
        mealPlanner: false,
        advancedAnalytics: false,
        weeklyReport: false,
        recipeGenerator: false,
        workoutGenerator: false,
        exportFormats: ['csv'],
      },
    },
    {
      code: 'pro',
      name: 'Pro',
      description: 'Higher AI limits, meal planner, coach, advanced analytics and reports.',
      priceMinor: 0,
      period: 'month',
      entitlements: {
        aiScansPerDay: 50,
        aiChatPerDay: 100,
        mealPlanner: true,
        advancedAnalytics: true,
        weeklyReport: true,
        recipeGenerator: true,
        workoutGenerator: true,
        exportFormats: ['csv', 'json'],
      },
    },
  ];

  for (const plan of plans) {
    await tx.query(
      `INSERT INTO plans (code, name, description, price_minor, billing_period, entitlements, is_active)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,true)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         price_minor = EXCLUDED.price_minor, billing_period = EXCLUDED.billing_period,
         entitlements = EXCLUDED.entitlements`,
      [
        plan.code,
        plan.name,
        plan.description,
        plan.priceMinor,
        plan.period,
        JSON.stringify(plan.entitlements),
      ],
    );
  }

  // ---- feature flags (spec §84) -----------------------------------------------------
  const flags = [
    { key: 'voice_logging', description: 'Log food by speaking.', enabled: true },
    {
      key: 'barcode_scanner',
      description: 'Scan product barcodes with the camera.',
      enabled: true,
    },
    { key: 'ai_recipes', description: 'AI recipe generation from pantry items.', enabled: true },
    {
      key: 'wearable_sync',
      description: 'Sync activity from a connected provider.',
      enabled: false,
    },
    {
      key: 'beta_food_segmentation',
      description: 'Draw detected food regions on the photo.',
      enabled: true,
    },
    {
      key: 'pantry_expiry',
      description: 'Pantry tracking with expiry-aware suggestions.',
      enabled: true,
    },
  ];

  for (const flag of flags) {
    await tx.query(
      `INSERT INTO feature_flags (key, description, enabled)
       VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [flag.key, flag.description, flag.enabled],
    );
  }

  return {
    categories: foodCategories.length,
    foods: seedFoods.length,
    servings,
    aliases,
    nutritionReferences: references,
    exercises: seedExercises.length,
    skippedFoods: skipped,
  };
}
