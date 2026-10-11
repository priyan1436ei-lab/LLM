import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';
import { currentSequence, totalSubscribers } from '@/lib/events';
import { capabilityReport } from '@/lib/capabilities';
import { env, isProduction } from '@/lib/env';

/**
 * Health check (spec §82, §126).
 *
 * Reports real state: whether the database actually answers a query, how many realtime
 * subscribers are attached, and which integrations are configured. It deliberately does NOT
 * report secret values — only whether a capability is available, which is already public
 * information to anyone using the product.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CheckResult {
  status: 'operational' | 'degraded' | 'down' | 'not_configured';
  detail?: string;
  latencyMs?: number;
}

async function checkDatabase(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const db = await getDb();
    // A real query, not just a handle check: this proves the engine responds.
    const result = await db.query<{ ok: number }>(`SELECT 1 AS ok`);
    if (result.rows[0]?.ok !== 1) {
      return {
        status: 'degraded',
        detail: 'The database answered but returned an unexpected result.',
      };
    }
    const latencyMs = Date.now() - started;

    // Confirm migrations are present, so a fresh-but-empty database is reported honestly
    // rather than appearing healthy.
    const migrations = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schema_migrations`,
    );
    const applied = Number(migrations.rows[0]?.n ?? 0);
    if (applied === 0) {
      return {
        status: 'degraded',
        detail: 'The database is reachable but no migrations have been applied.',
        latencyMs,
      };
    }

    return { status: 'operational', detail: `${applied} migration(s) applied`, latencyMs };
  } catch (error) {
    return {
      status: 'down',
      detail: error instanceof Error ? error.message : 'The database is unreachable.',
    };
  }
}

async function checkQueue(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const db = await getDb();
    const rows = await db.query<{ queued: number; failed: number }>(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::int  AS queued,
         count(*) FILTER (WHERE status = 'failed')::int  AS failed
       FROM job_queue`,
    );
    const row = rows.rows[0];
    const failed = Number(row?.failed ?? 0);
    return {
      status: failed > 0 ? 'degraded' : 'operational',
      detail: `${Number(row?.queued ?? 0)} queued, ${failed} failed`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      status: 'down',
      detail: error instanceof Error ? error.message : 'The job queue is unreachable.',
    };
  }
}

export async function GET(): Promise<NextResponse> {
  const started = Date.now();

  const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);

  const capabilities = capabilityReport();

  // A capability that the product advertises but cannot deliver is reported as
  // `not_configured`, never hidden or faked (spec §136).
  const aiItems = capabilities.capabilities.filter(
    (c) => c.key.startsWith('ai_') || c.key === 'barcode_product_lookup',
  );

  const integrations: Record<string, CheckResult> = {};
  for (const item of aiItems) {
    integrations[item.key] = {
      status: item.state === 'available' ? 'operational' : 'not_configured',
      detail: item.reason,
    };
  }

  const payments = capabilities.capabilities.find((c) => c.key === 'payments');
  integrations.payments = {
    status: payments?.state === 'available' ? 'operational' : 'not_configured',
    detail: payments?.reason ?? 'Unknown',
  };

  // Overall status is the worst of the critical checks.
  const critical = [database.status];
  const overall = critical.includes('down')
    ? 'down'
    : critical.includes('degraded')
      ? 'degraded'
      : 'operational';

  const body = {
    status: overall,
    version: process.env.npm_package_version ?? '0.1.0',
    environment: isProduction() ? 'production' : env().APP_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    responseTimeMs: Date.now() - started,
    checks: {
      app: { status: 'operational' as const },
      database,
      queue,
    },
    realtime: {
      status: 'operational' as const,
      subscribers: totalSubscribers(),
      sequence: currentSequence('__global__'),
    },
    integrations,
    // Which capabilities are genuinely usable right now. The UI reads the same values.
    capabilities: capabilities.available,
  };

  // Health endpoints must not be cached by a CDN or proxy.
  return NextResponse.json(body, {
    status: overall === 'down' ? 503 : 200,
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}
