import { AsyncLocalStorage } from 'node:async_hooks';

import { publish, type AppEventType } from '@/lib/events';

/**
 * Commit-safe event emission (spec §89, §90).
 *
 * A realtime event must never describe state that was subsequently rolled back. If a
 * service published directly inside its transaction, a subscriber could receive
 * "meal.created" for a meal that then failed to commit — and a client would render a
 * phantom entry.
 *
 * So services enqueue events with `emitAfterCommit`. The event is buffered in an
 * AsyncLocalStorage context that `runInTransactionScope` establishes, and it is flushed
 * only once the surrounding transaction has actually committed. If the transaction
 * throws, the buffer is discarded and nothing is published.
 */

interface EmitBuffer {
  events: { type: AppEventType; userId: string; payload: Record<string, unknown> }[];
}

const emitContext = new AsyncLocalStorage<EmitBuffer>();

/** Queue an event for publication after the current transaction commits. */
export function emitAfterCommit(params: {
  type: AppEventType;
  userId: string;
  payload?: Record<string, unknown>;
}): void {
  const buffer = emitContext.getStore();
  if (!buffer) {
    // No transaction scope is active. Publishing immediately would be wrong if a caller
    // later rolled back, so we refuse rather than guess — this is a programming error.
    throw new Error(
      `emitAfterCommit("${params.type}") was called outside a transaction scope. ` +
        'Wrap the operation in runInTransactionScope so events are published only after commit.',
    );
  }
  buffer.events.push({
    type: params.type,
    userId: params.userId,
    payload: params.payload ?? {},
  });
}

/**
 * Run `fn` inside a transaction, buffering any events it enqueues and publishing them
 * only after the transaction commits successfully.
 */
export async function runInTransactionScope<T>(fn: () => Promise<T>): Promise<T> {
  const buffer: EmitBuffer = { events: [] };

  const result = await emitContext.run(buffer, fn);

  // Reached only when the transaction did not throw, i.e. it committed.
  for (const event of buffer.events) {
    publish(event.type, event.userId, event.payload);
  }

  return result;
}

/** Events queued so far in the current scope. Used by tests. */
export function pendingEventCount(): number {
  return emitContext.getStore()?.events.length ?? 0;
}
