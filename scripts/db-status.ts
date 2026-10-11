/**
 * Schema introspection CLI.
 *
 *   npm run db:status            tables, RLS coverage, indexes, row counts
 *   npm run db:status -- --rls   RLS audit only (exit 1 on any unprotected user table)
 */
import { getDb, closeDb, USER_SCOPED_TABLES } from '../src/db/client';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const rlsOnly = new Set(process.argv.slice(2)).has('--rls');
  const db = await getDb();

  const tables = (
    await db.query<Row>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    )
  ).rows;

  const withUserId = new Set(
    (
      await db.query<Row>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema='public' AND column_name='user_id' AND data_type='uuid'`,
      )
    ).rows.map((r) => String(r.table_name)),
  );

  console.log(
    `Engine: ${String((await db.query<Row>(`SELECT version() AS v`)).rows[0]?.v).slice(0, 60)}`,
  );
  console.log(`Tables in public: ${tables.length}`);
  console.log(`Tables with a user_id uuid column: ${withUserId.size}`);

  if (!rlsOnly) {
    const indexes = (
      await db.query<Row>(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`)
    ).rows[0]?.n;
    const enums = (
      await db.query<Row>(
        `SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname='public' AND t.typtype='e'`,
      )
    ).rows[0]?.n;
    const fns = (
      await db.query<Row>(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'`,
      )
    ).rows[0]?.n;
    console.log(`Indexes: ${indexes}   Enum types: ${enums}   Functions: ${fns}`);
    console.log('');

    console.log('--- tables ---');
    for (const t of tables) {
      const flags = [
        Boolean(t.rls) ? 'RLS' : '   ',
        Boolean(t.forced) ? 'FORCED' : '      ',
        `${String(t.policies).padStart(2)} policies`,
      ].join(' ');
      console.log(`  ${String(t.name).padEnd(28)} ${flags}`);
    }
  }

  // ---- RLS audit -------------------------------------------------------------------
  // Any table carrying user_id MUST have RLS enabled and at least one policy.
  const problems: string[] = [];
  for (const name of withUserId) {
    const t = tables.find((x) => x.name === name);
    if (!t) {
      problems.push(`${name}: has user_id but is not a base table`);
      continue;
    }
    if (!t.rls) problems.push(`${name}: RLS is NOT enabled`);
    else if (!t.forced) problems.push(`${name}: RLS enabled but not FORCEd`);
    if (Number(t.policies) === 0) problems.push(`${name}: RLS enabled but has zero policies`);
  }

  // Cross-check against what the application believes it owns.
  for (const declared of USER_SCOPED_TABLES) {
    if (!tables.some((t) => t.name === declared)) {
      problems.push(`${declared}: declared user-scoped by the app but missing from the schema`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log(`RLS audit: PASS (${withUserId.size} user-scoped tables all protected)`);
  } else {
    console.log(`RLS audit: FAIL (${problems.length} problem(s))`);
    for (const p of problems) console.log(`  ! ${p}`);
    process.exitCode = 1;
  }

  // ---- Prove enforcement, not just configuration -----------------------------------
  if (!rlsOnly) {
    console.log('');
    console.log('--- RLS enforcement probe (two identities, one table) ---');
    const u1 = '11111111-1111-4111-8111-111111111111';
    const u2 = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO profiles (id, email, password_hash, display_name)
      VALUES ('${u1}','probe-one@example.test','x','Probe One'),
             ('${u2}','probe-two@example.test','x','Probe Two')
      ON CONFLICT DO NOTHING;
      INSERT INTO meals (user_id, meal_type, meal_date, title)
      VALUES ('${u1}','lunch',current_date,'probe-one lunch'),
             ('${u2}','lunch',current_date,'probe-two lunch');
    `);

    for (const [label, uid] of [
      ['user-1', u1],
      ['user-2', u2],
    ] as const) {
      const rows = await db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE app_user;`);
        await tx.exec(`SET LOCAL app.current_user_id = '${uid}';`);
        return (await tx.query<Row>(`SELECT title FROM meals ORDER BY title`)).rows;
      });
      console.log(`  as ${label}: sees ${JSON.stringify(rows.map((r) => r.title))}`);
    }

    // Clean up probe rows so a dev database is not polluted.
    await db.exec(
      `DELETE FROM meals WHERE title LIKE 'probe-%'; DELETE FROM profiles WHERE email LIKE 'probe-%@example.test';`,
    );
    console.log('  (probe rows removed)');
  }

  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeDb();
});
