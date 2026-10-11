/**
 * Seed CLI (spec §104).
 *
 *   npm run db:seed                  load reference data only (safe in any environment)
 *   npm run db:seed -- --with-demo   additionally create a local demo account
 *
 * Reference data is idempotent. The demo account is strictly local: it is refused when
 * APP_ENV is production, so no production database can be given a known credential.
 */
import { closeDb, transaction } from '../src/db/client';
import { seedReferenceData } from '../src/db/seed';
import { hashPassword } from '../src/lib/crypto';
import { isProduction, productionReadinessProblems } from '../src/lib/env';

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const withDemo = argv.has('--with-demo');

  const problems = productionReadinessProblems();
  if (problems.length > 0) {
    console.error('Refusing to seed: production configuration is incomplete.');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const report = await transaction(async (tx) => seedReferenceData(tx));

  console.log('Reference data seeded (idempotent).');
  console.log(`  categories            : ${report.categories}`);
  console.log(`  foods                 : ${report.foods}`);
  console.log(`  servings              : ${report.servings}`);
  console.log(`  aliases               : ${report.aliases}`);
  console.log(`  nutrition references  : ${report.nutritionReferences}`);
  console.log(`  exercises             : ${report.exercises}`);
  if (report.skippedFoods.length > 0) {
    console.log(`  skipped               : ${report.skippedFoods.join(', ')}`);
  }

  if (!withDemo) return;

  if (isProduction()) {
    console.error(
      '\nRefusing to create a demo account: APP_ENV is production. A known credential must ' +
        'never exist in a production database.',
    );
    process.exitCode = 1;
    return;
  }

  const demoEmail = process.env.DEMO_EMAIL ?? 'demo@fittrack.local';
  // Read at run time from the environment. Never a literal in source: a known credential
  // in version control is a security defect, not a convenience.
  const credentialFromEnv = process.env.DEMO_PASSWORD;

  if (!credentialFromEnv) {
    console.error(
      '\nDEMO_PASSWORD is not set, so no demo account was created. Creating one with a ' +
        'hard-coded credential would be unsafe. Set DEMO_PASSWORD and re-run with --with-demo.',
    );
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(credentialFromEnv);
  const demoTimezone = process.env.DEMO_TIMEZONE ?? 'Asia/Kolkata';

  await transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, display_name, email_verified_at, onboarding_done_at, timezone)
       VALUES ($1,$2,$3, now(), now(), $4)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [demoEmail, passwordHash, 'Demo User', demoTimezone],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error('Failed to create the demo account.');

    await tx.query(
      `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await tx.query(
      `INSERT INTO user_body_stats (user_id, sex, birth_date, height_cm, activity_level)
       VALUES ($1,'female','1994-04-12',162,'moderate')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await tx.query(
      `INSERT INTO nutrition_goals (user_id, effective_from, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, water_ml)
       VALUES ($1, current_date, 2000, 120, 225, 56, 28, 3000)
       ON CONFLICT (user_id, effective_from) DO NOTHING`,
      [userId],
    );

    console.log(`\nDemo account ready: ${demoEmail}`);
    console.log('  (credential taken from DEMO_PASSWORD, not stored in code)');
  });
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
