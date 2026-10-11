/**
 * Database access, RLS isolation and tenant-scoping tests.
 *
 * These run against a REAL PostgreSQL engine (PGlite 0.5.8 / PostgreSQL 18.3), not a
 * mock, so they exercise the actual row-level security implementation rather than a
 * stand-in. Each test file gets its own data directory to respect the engine's
 * single-writer constraint.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'fittrack-rls-'));
  // Must be set before any module reads the environment.
  process.env.PGLITE_DATA_DIR = tempDir;
  process.env.APP_ENV = 'development';

  const { migrate } = await import('@/db/migrate');
  await migrate();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/client');
  await closeDb();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function createUser(email: string, displayName: string): Promise<string> {
  const { transaction } = await import('@/db/client');
  const rows = await transaction(async (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [email, 'x', displayName],
    ),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('failed to create user');
  return id;
}

describe('migrations', () => {
  it('applies cleanly and is idempotent', async () => {
    const { migrate } = await import('@/db/migrate');
    const second = await migrate();
    expect(second.applied).toHaveLength(0);
  });

  it('reports no drift', async () => {
    const { assertNoMigrationDrift } = await import('@/db/migrate');
    await expect(assertNoMigrationDrift()).resolves.toBeUndefined();
  });
});

describe('row-level security', () => {
  it('protects every table that carries a user_id column', async () => {
    const { getDb } = await import('@/db/client');
    const db = await getDb();

    const unprotected = (
      await db.query<{ name: string }>(`
        SELECT c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT c.relrowsecurity
           AND EXISTS (
             SELECT 1 FROM information_schema.columns col
              WHERE col.table_schema = 'public'
                AND col.table_name = c.relname
                AND col.column_name = 'user_id'
                AND col.data_type = 'uuid'
           )
        ORDER BY c.relname
      `)
    ).rows.map((r) => r.name);

    expect(unprotected).toEqual([]);
  });

  it('forces RLS even on the table owner', async () => {
    const { getDb } = await import('@/db/client');
    const db = await getDb();
    const notForced = (
      await db.query<{ name: string }>(`
        SELECT c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relrowsecurity AND NOT c.relforcerowsecurity
         ORDER BY c.relname
      `)
    ).rows.map((r) => r.name);
    expect(notForced).toEqual([]);
  });

  it('gives every RLS-enabled table at least one policy', async () => {
    const { getDb } = await import('@/db/client');
    const db = await getDb();
    const empty = (
      await db.query<{ name: string }>(`
        SELECT c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
           AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
         ORDER BY c.relname
      `)
    ).rows.map((r) => r.name);
    expect(empty).toEqual([]);
  });

  it("isolates one user from another user's rows", async () => {
    const { withUser } = await import('@/db/tenant');
    const { transaction } = await import('@/db/client');

    const alice = await createUser('alice@example.test', 'Alice');
    const bob = await createUser('bob@example.test', 'Bob');

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES
           ($1,'breakfast',current_date,'alice breakfast'),
           ($2,'lunch',current_date,'bob lunch')`,
        [alice, bob],
      );
    });

    const aliceSees = await withUser({ userId: alice, role: 'user' }, (tx) =>
      tx.query<{ title: string }>(`SELECT title FROM meals ORDER BY title`),
    );
    const bobSees = await withUser({ userId: bob, role: 'user' }, (tx) =>
      tx.query<{ title: string }>(`SELECT title FROM meals ORDER BY title`),
    );

    expect(aliceSees.map((r) => r.title)).toEqual(['alice breakfast']);
    expect(bobSees.map((r) => r.title)).toEqual(['bob lunch']);
  });

  it('rejects an INSERT that forges another user as owner', async () => {
    const { withUser } = await import('@/db/tenant');
    const { transaction } = await import('@/db/client');

    const carol = await createUser('carol@example.test', 'Carol');
    const dave = await createUser('dave@example.test', 'Dave');

    // Carol attempts to write a meal owned by Dave.
    await expect(
      withUser({ userId: carol, role: 'user' }, (tx) =>
        tx.query(
          `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES ($1,'dinner',current_date,'forged')`,
          [dave],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // And Dave genuinely has no such row.
    const daveMeals = await withUser({ userId: dave, role: 'user' }, (tx) =>
      tx.query<{ title: string }>(`SELECT title FROM meals`),
    );
    expect(daveMeals).toHaveLength(0);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM meals WHERE user_id IN ($1,$2)`, [carol, dave]);
    });
  });

  it('makes a cross-user UPDATE and DELETE affect zero rows', async () => {
    const { withUser } = await import('@/db/tenant');
    const { transaction } = await import('@/db/client');

    const erin = await createUser('erin@example.test', 'Erin');
    const frank = await createUser('frank@example.test', 'Frank');

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES ($1,'lunch',current_date,'erin lunch')`,
        [erin],
      );
    });

    const updated = await withUser({ userId: frank, role: 'user' }, (tx) =>
      tx.query(`UPDATE meals SET title = 'hijacked' WHERE title = 'erin lunch' RETURNING id`),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withUser({ userId: frank, role: 'user' }, (tx) =>
      tx.query(`DELETE FROM meals WHERE title = 'erin lunch' RETURNING id`),
    );
    expect(deleted).toHaveLength(0);

    // Erin's row is untouched.
    const still = await withUser({ userId: erin, role: 'user' }, (tx) =>
      tx.query<{ title: string }>(`SELECT title FROM meals`),
    );
    expect(still.map((r) => r.title)).toEqual(['erin lunch']);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM meals WHERE user_id IN ($1,$2)`, [erin, frank]);
    });
  });

  it('fails closed when no user context is set', async () => {
    const { transaction } = await import('@/db/client');
    const grace = await createUser('grace@example.test', 'Grace');
    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES ($1,'lunch',current_date,'grace lunch')`,
        [grace],
      );
    });

    // Acting as app_user with NO app.current_user_id must yield zero rows, never all rows.
    const rows = await transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      return tx.query<{ title: string }>(`SELECT title FROM meals`);
    });
    expect(rows).toHaveLength(0);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM meals WHERE user_id = $1`, [grace]);
    });
  });

  it('does not leak user context between interleaved requests', async () => {
    const { withUser } = await import('@/db/tenant');
    const { transaction } = await import('@/db/client');

    const u1 = await createUser('interleave1@example.test', 'One');
    const u2 = await createUser('interleave2@example.test', 'Two');

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES
           ($1,'lunch',current_date,'one-only'), ($2,'lunch',current_date,'two-only')`,
        [u1, u2],
      );
    });

    // Fire overlapping scoped reads. If the per-transaction context leaked across the
    // shared connection, one of these would see the other user's row.
    const results = await Promise.all([
      withUser({ userId: u1, role: 'user' }, async (tx) => {
        await new Promise((r) => setTimeout(r, 15));
        return (await tx.query<{ title: string }>(`SELECT title FROM meals`)).map((r) => r.title);
      }),
      withUser({ userId: u2, role: 'user' }, async (tx) => {
        await new Promise((r) => setTimeout(r, 10));
        return (await tx.query<{ title: string }>(`SELECT title FROM meals`)).map((r) => r.title);
      }),
      withUser({ userId: u1, role: 'user' }, (tx) =>
        tx.query<{ title: string }>(`SELECT title FROM meals`).then((r) => r.map((x) => x.title)),
      ),
      withUser({ userId: u2, role: 'user' }, (tx) =>
        tx.query<{ title: string }>(`SELECT title FROM meals`).then((r) => r.map((x) => x.title)),
      ),
    ]);

    expect(results[0]).toEqual(['one-only']);
    expect(results[1]).toEqual(['two-only']);
    expect(results[2]).toEqual(['one-only']);
    expect(results[3]).toEqual(['two-only']);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM meals WHERE user_id IN ($1,$2)`, [u1, u2]);
    });
  });

  it('protects child tables through their parent', async () => {
    const { withUser } = await import('@/db/tenant');
    const { transaction } = await import('@/db/client');

    const owner = await createUser('childowner@example.test', 'Owner');
    const other = await createUser('childother@example.test', 'Other');

    const mealId = await transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO meals (user_id, meal_type, meal_date, title) VALUES ($1,'lunch',current_date,'with items') RETURNING id`,
        [owner],
      );
      const id = rows[0]!.id;
      await tx.query(
        `INSERT INTO meal_items (meal_id, display_name, quantity, unit, grams, calories_kcal, protein_g, carbs_g, fat_g)
         VALUES ($1,'Idli',2,'piece',90,120,4,24,0.5)`,
        [id],
      );
      return id;
    });

    const ownerItems = await withUser({ userId: owner, role: 'user' }, (tx) =>
      tx.query(`SELECT id FROM meal_items WHERE meal_id = $1`, [mealId]),
    );
    expect(ownerItems).toHaveLength(1);

    const otherItems = await withUser({ userId: other, role: 'user' }, (tx) =>
      tx.query(`SELECT id FROM meal_items WHERE meal_id = $1`, [mealId]),
    );
    expect(otherItems).toHaveLength(0);

    await transaction(async (tx) => {
      await tx.query(`DELETE FROM meals WHERE user_id = $1`, [owner]);
    });
  });
});

describe('append-only ledgers', () => {
  it('refuses to delete or update an audit row', async () => {
    const { transaction } = await import('@/db/client');
    await transaction(async (tx) => {
      await tx.query(`INSERT INTO audit_logs (action, status) VALUES ('probe.action','success')`);
    });

    await expect(
      transaction(async (tx) => tx.query(`DELETE FROM audit_logs WHERE action = 'probe.action'`)),
    ).rejects.toThrow(/append-only/i);

    await expect(
      transaction(async (tx) =>
        tx.query(`UPDATE audit_logs SET action = 'changed' WHERE action = 'probe.action'`),
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
