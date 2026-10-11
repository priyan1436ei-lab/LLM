/**
 * Migration CLI (spec §103).
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --plan  show what would run, change nothing
 *   npm run db:migrate -- --check fail if applied migrations changed on disk
 */
import { assertNoMigrationDrift, migrate, planMigrations } from '../src/db/migrate';
import { closeDb } from '../src/db/client';
import { productionReadinessProblems } from '../src/lib/env';

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));

  const problems = productionReadinessProblems();
  if (problems.length > 0) {
    console.error('Refusing to run migrations: production configuration is incomplete.');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  if (argv.has('--check')) {
    await assertNoMigrationDrift();
    console.log('No migration drift detected.');
    return;
  }

  if (argv.has('--plan')) {
    const plan = await planMigrations();
    console.log(`Pending migrations: ${plan.pending.length}`);
    for (const m of plan.pending) console.log(`  + ${m.version}_${m.name}`);
    if (plan.drifted.length > 0) {
      console.log(`Drifted (already applied, file changed): ${plan.drifted.length}`);
      for (const d of plan.drifted) console.log(`  ! ${d.version}_${d.name}`);
    }
    return;
  }

  const report = await migrate();

  if (report.applied.length === 0) {
    console.log('Database is up to date; nothing to apply.');
  } else {
    console.log(`Applied ${report.applied.length} migration(s):`);
    for (const m of report.applied) {
      console.log(`  + ${m.version}_${m.name} (${m.durationMs} ms)`);
    }
  }

  if (report.drifted.length > 0) {
    console.error(
      `\nWARNING: ${report.drifted.length} already-applied migration(s) were modified on disk:`,
    );
    for (const d of report.drifted) console.error(`  ! ${d.version}_${d.name}`);
    console.error('Add a new migration instead of editing an applied one.');
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('Migration failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
