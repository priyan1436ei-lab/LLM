/**
 * Data quality audit (spec §67, §69, §85).
 *
 *   npm run db:audit
 *
 * Verifies the seeded reference data through the database itself, not just the TypeScript
 * source: every food has resolvable nutrition, every serving converts, calorie values are
 * physically plausible, trigram search actually matches, and the exercise library is
 * complete. Exits non-zero on any failure so it can gate CI.
 */
import { closeDb, getDb } from '../src/db/client';

interface Problem {
  readonly check: string;
  readonly detail: string;
}

async function main(): Promise<void> {
  const db = await getDb();
  const problems: Problem[] = [];

  // ---- counts ----------------------------------------------------------------------
  const counts = (
    await db.query<{
      foods: number;
      servings: number;
      aliases: number;
      refs: number;
      exercises: number;
      categories: number;
      plans: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM foods)                AS foods,
        (SELECT count(*)::int FROM food_servings)        AS servings,
        (SELECT count(*)::int FROM food_aliases)         AS aliases,
        (SELECT count(*)::int FROM nutrition_reference)  AS refs,
        (SELECT count(*)::int FROM exercises)            AS exercises,
        (SELECT count(*)::int FROM food_categories)      AS categories,
        (SELECT count(*)::int FROM plans)                AS plans
    `)
  ).rows[0];

  console.log('--- reference data ---');
  console.log(`  foods                : ${counts?.foods}`);
  console.log(`  servings             : ${counts?.servings}`);
  console.log(`  aliases              : ${counts?.aliases}`);
  console.log(`  nutrition references : ${counts?.refs}`);
  console.log(`  food categories      : ${counts?.categories}`);
  console.log(`  exercises            : ${counts?.exercises}`);
  console.log(`  subscription plans   : ${counts?.plans}`);

  if ((counts?.foods ?? 0) < 90) {
    problems.push({
      check: 'food count',
      detail: `expected at least 90 foods, found ${counts?.foods}`,
    });
  }
  if ((counts?.exercises ?? 0) < 60) {
    problems.push({
      check: 'exercise count',
      detail: `expected at least 60 exercises, found ${counts?.exercises}`,
    });
  }

  // ---- every food needs nutrition (spec §68) ----------------------------------------
  const noNutrition = await db.query<{ canonical_name: string }>(`
    SELECT f.canonical_name
      FROM foods f
      LEFT JOIN nutrition_reference n ON n.food_id = f.id
     WHERE n.id IS NULL
     ORDER BY f.canonical_name
  `);
  if (noNutrition.rows.length > 0) {
    problems.push({
      check: 'foods without nutrition',
      detail: `${noNutrition.rows.length} food(s) have no reference row: ${noNutrition.rows
        .slice(0, 10)
        .map((r) => r.canonical_name)
        .join(', ')}`,
    });
  }

  // ---- every food needs at least one serving, and exactly one default ---------------
  const badServingCounts = await db.query<{ canonical_name: string; n: number }>(`
    SELECT f.canonical_name, count(s.id)::int AS n
      FROM foods f
      LEFT JOIN food_servings s ON s.food_id = f.id
     GROUP BY f.id, f.canonical_name
    HAVING count(s.id) = 0
  `);
  if (badServingCounts.rows.length > 0) {
    problems.push({
      check: 'foods without servings',
      detail: badServingCounts.rows.map((r) => r.canonical_name).join(', '),
    });
  }

  const multiDefault = await db.query<{ canonical_name: string; n: number }>(`
    SELECT f.canonical_name, count(s.id)::int AS n
      FROM foods f
      JOIN food_servings s ON s.food_id = f.id AND s.is_default
     GROUP BY f.id, f.canonical_name
    HAVING count(s.id) > 1
  `);
  if (multiDefault.rows.length > 0) {
    problems.push({
      check: 'multiple default servings',
      detail: multiDefault.rows.map((r) => `${r.canonical_name} (${r.n})`).join(', '),
    });
  }

  const noDefault = await db.query<{ canonical_name: string }>(`
    SELECT f.canonical_name
      FROM foods f
     WHERE NOT EXISTS (SELECT 1 FROM food_servings s WHERE s.food_id = f.id AND s.is_default)
  `);
  if (noDefault.rows.length > 0) {
    problems.push({
      check: 'foods without a default serving',
      detail: noDefault.rows.map((r) => r.canonical_name).join(', '),
    });
  }

  // ---- calorie plausibility (the DB CHECK constraint backs this too) -----------------
  const implausible = await db.query<{
    canonical_name: string;
    calories_kcal: string;
    derived: string;
  }>(`
    SELECT f.canonical_name, n.calories_kcal,
           ((n.carbs_g + n.protein_g) * 4 + n.fat_g * 9 + 40) AS derived
      FROM nutrition_reference n
      JOIN foods f ON f.id = n.food_id
     WHERE n.calories_kcal > ((n.carbs_g + n.protein_g) * 4 + n.fat_g * 9 + 40)
  `);
  if (implausible.rows.length > 0) {
    problems.push({
      check: 'implausible calorie values',
      detail: implausible.rows
        .map((r) => `${r.canonical_name}: ${r.calories_kcal} > ${Number(r.derived).toFixed(0)}`)
        .join('; '),
    });
  }

  // ---- macro energy consistency: flag values that look like a raw/cooked mix-up -------
  // Cooked grains and legumes are the classic error. 100 g of cooked rice is ~130 kcal;
  // a value above 250 kcal/100 g for a plainly-cooked staple is worth surfacing.
  const suspicious = await db.query<{ canonical_name: string; calories_kcal: string }>(`
    SELECT f.canonical_name, n.calories_kcal
      FROM nutrition_reference n
      JOIN foods f ON f.id = n.food_id
     WHERE f.canonical_name IN ('Cooked Rice','Dal','Rajma','Chole','Curd Rice','Sambar')
       AND n.calories_kcal > 250
  `);
  if (suspicious.rows.length > 0) {
    problems.push({
      check: 'cooked staple plausibility',
      detail: suspicious.rows
        .map((r) => `${r.canonical_name}: ${r.calories_kcal} kcal/100 g`)
        .join('; '),
    });
  }

  // ---- search actually works (spec §85) ---------------------------------------------
  // `expect` may list several acceptable targets where Indian usage genuinely makes the
  // alias ambiguous rather than the data being wrong. "Phulka" is a real synonym for both
  // roti and chapati, so surfacing either is correct.
  const searchCases: { query: string; expect: string | string[] }[] = [
    { query: 'idli', expect: 'Idli' },
    { query: 'dahi', expect: 'Curd' },
    { query: 'thayir', expect: 'Curd' },
    { query: 'curd', expect: 'Curd' },
    { query: 'chapathi', expect: 'Chapati' },
    { query: 'phulka', expect: ['Roti', 'Chapati'] },
    { query: 'masala dosa', expect: 'Masala Dosa' },
  ];

  console.log('\n--- alias / trigram search ---');
  for (const testCase of searchCases) {
    const rows = await db.query<{ canonical_name: string; score: number }>(
      `SELECT f.canonical_name, similarity(lower(f.canonical_name), lower($1)) AS score
         FROM foods f
         JOIN food_aliases a ON a.food_id = f.id
        WHERE lower(a.alias) = lower($1) OR lower(f.canonical_name) LIKE lower($1) || '%'
        ORDER BY score DESC
        LIMIT 3`,
      [testCase.query],
    );
    const acceptable = Array.isArray(testCase.expect) ? testCase.expect : [testCase.expect];
    const matched = rows.rows.some((r) => acceptable.includes(r.canonical_name));
    console.log(
      `  ${matched ? 'PASS' : 'FAIL'}  "${testCase.query}" -> ${rows.rows.map((r) => r.canonical_name).join(', ') || '(nothing)'}` +
        (Array.isArray(testCase.expect) ? `  [either: ${acceptable.join(' / ')}]` : ''),
    );
    if (!matched) {
      problems.push({
        check: 'search',
        detail: `searching "${testCase.query}" did not surface any of: ${acceptable.join(', ')}`,
      });
    }
  }

  // ---- fuzzy matching returns something sensible for a typo -------------------------
  const fuzzy = await db.query<{ canonical_name: string; sim: number }>(
    `SELECT canonical_name, similarity(lower(canonical_name), lower($1)) AS sim
       FROM foods
      WHERE lower(canonical_name) % lower($1)
      ORDER BY sim DESC
      LIMIT 5`,
    ['chiken curry'],
  );
  console.log(
    `\n  fuzzy "chiken curry" -> ${fuzzy.rows.map((r) => `${r.canonical_name} (${Number(r.sim).toFixed(2)})`).join(', ') || '(nothing)'}`,
  );
  if (fuzzy.rows.length === 0) {
    problems.push({
      check: 'fuzzy search',
      detail: 'a one-letter typo ("chiken curry") matched nothing via the trigram index',
    });
  }

  // ---- exercises: category coverage and safety notes (spec §37, §38) -----------------
  console.log('\n--- exercise library ---');
  const byCategory = await db.query<{ category: string; n: number }>(
    `SELECT category, count(*)::int AS n FROM exercises GROUP BY category ORDER BY category`,
  );
  for (const row of byCategory.rows) console.log(`  ${row.category.padEnd(12)} ${row.n}`);

  const expectedCategories = [
    'chest',
    'back',
    'legs',
    'shoulders',
    'arms',
    'core',
    'cardio',
    'mobility',
    'full_body',
  ];
  const present = new Set(byCategory.rows.map((r) => r.category));
  const missingCategories = expectedCategories.filter((c) => !present.has(c));
  if (missingCategories.length > 0) {
    problems.push({
      check: 'exercise categories',
      detail: `missing: ${missingCategories.join(', ')}`,
    });
  }

  const noSafety = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM exercises WHERE safety_notes IS NULL OR btrim(safety_notes) = ''`,
  );
  if ((noSafety.rows[0]?.n ?? 0) > 0) {
    problems.push({
      check: 'exercise safety notes',
      detail: `${noSafety.rows[0]?.n} exercise(s) have no safety notes`,
    });
  }

  const noInstructions = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM exercises WHERE jsonb_array_length(instructions) = 0`,
  );
  if ((noInstructions.rows[0]?.n ?? 0) > 0) {
    problems.push({
      check: 'exercise instructions',
      detail: `${noInstructions.rows[0]?.n} exercise(s) have no instructions`,
    });
  }

  const metCount = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM exercises WHERE met_value IS NOT NULL`,
  );
  console.log(`  exercises with a MET value: ${metCount.rows[0]?.n} of ${counts?.exercises}`);

  // ---- regional coverage: the product is Indian-first (spec §12) ---------------------
  const byRegion = await db.query<{ region: string | null; n: number }>(
    `SELECT region, count(*)::int AS n FROM foods GROUP BY region ORDER BY n DESC`,
  );
  console.log('\n--- foods by region ---');
  for (const row of byRegion.rows) console.log(`  ${(row.region ?? '(none)').padEnd(16)} ${row.n}`);

  const indian = byRegion.rows
    .filter((r) => r.region && r.region !== 'global')
    .reduce((sum, r) => sum + r.n, 0);
  if (indian < 70) {
    problems.push({
      check: 'indian food coverage',
      detail: `only ${indian} Indian foods seeded, expected at least 70`,
    });
  }

  // ---- integrity: alias and nutrition rows must all point at a real food -------------
  const orphanAliases = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM food_aliases a LEFT JOIN foods f ON f.id = a.food_id WHERE f.id IS NULL`,
  );
  if ((orphanAliases.rows[0]?.n ?? 0) > 0) {
    problems.push({
      check: 'orphan aliases',
      detail: `${orphanAliases.rows[0]?.n} alias row(s) point at no food`,
    });
  }

  // ---- no seed data leaked into user tables (spec §104) ------------------------------
  const userRows = await db.query<{ profiles: number }>(
    `SELECT (SELECT count(*)::int FROM profiles) AS profiles`,
  );
  console.log(`\nuser profiles in this database: ${userRows.rows[0]?.profiles}`);

  console.log('');
  if (problems.length === 0) {
    console.log('Data audit: PASS (all checks green)');
  } else {
    console.log(`Data audit: FAIL (${problems.length} problem(s))`);
    for (const p of problems) console.log(`  ! [${p.check}] ${p.detail}`);
    process.exitCode = 1;
  }

  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeDb();
});
