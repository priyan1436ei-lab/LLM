/**
 * Realtime event bus (spec §1, §89, §90).
 *
 * The product spec requires that a change made on one device appears on another without a
 * manual refresh. This module is the in-process fan-out that makes that work: a write path
 * publishes an event, and every open stream for that user receives it.
 *
 * Design notes:
 *  - Events are per-user and addressed by user id. A subscriber can only ever receive
 *    events for the user it authenticated as, because the subscription key IS the user id
 *    taken from the verified session — there is no client-supplied channel name to forge.
 *  - Payloads carry identifiers and the authoritative summary numbers, never secrets and
 *    never another user's data.
 *  - This is single-process fan-out. A multi-instance deployment needs a shared broker
 *    (Redis pub/sub, Postgres LISTEN/NOTIFY); `publish` is the single place to change.
 */

import type { NutrientValues } from './nutrition';

export type AppEventType =
  | 'meal.created'
  | 'meal.updated'
  | 'meal.deleted'
  | 'summary.updated'
  | 'water.logged'
  | 'weight.logged'
  | 'measurement.logged'
  | 'workout.started'
  | 'workout.completed'
  | 'habit.updated'
  | 'scan.queued'
  | 'scan.progress'
  | 'scan.completed'
  | 'scan.failed'
  | 'goal.updated'
  | 'notification.created'
  | 'notification.read'
  | 'subscription.updated'
  | 'insight.created'
  | 'plan.updated'
  | 'achievement.unlocked';

export interface AppEvent {
  readonly type: AppEventType;
  readonly userId: string;
  /** Monotonic per-user sequence so a client can detect a missed event. */
  readonly sequence: number;
  readonly at: string;
  readonly payload: Record<string, unknown>;
  /** Stable id for de-duplication on the client. */
  readonly eventId: string;
}

export interface SummaryPayload {
  readonly date: string;
  readonly nutrients: NutrientValues;
  readonly waterMl: number;
  readonly workoutMinutes: number;
  readonly mealsLogged: number;
  readonly revision: number;
}

type Subscriber = (event: AppEvent) => void;

interface UserChannel {
  subscribers: Set<Subscriber>;
  sequence: number;
}

const globalForBus = globalThis as unknown as {
  __fittrackBus?: Map<string, UserChannel>;
};

const channels: Map<string, UserChannel> = (globalForBus.__fittrackBus ??= new Map());

function channelFor(userId: string): UserChannel {
  let channel = channels.get(userId);
  if (!channel) {
    channel = { subscribers: new Set(), sequence: 0 };
    channels.set(userId, channel);
  }
  return channel;
}

/**
 * Subscribe to a user's stream. Returns an unsubscribe function.
 * Subscribers are never given events for any other user id.
 */
export function subscribe(userId: string, subscriber: Subscriber): () => void {
  const channel = channelFor(userId);
  channel.subscribers.add(subscriber);
  return () => {
    channel.subscribers.delete(subscriber);
    // Release the channel when nobody is listening, so a long-running process does not
    // accumulate an entry per user who ever connected.
    if (channel.subscribers.size === 0 && channel.sequence === 0) {
      channels.delete(userId);
    }
  };
}

/** Publish an event to everyone currently streaming that user's changes. */
export function publish(
  type: AppEventType,
  userId: string,
  payload: Record<string, unknown> = {},
): AppEvent {
  const channel = channelFor(userId);
  channel.sequence += 1;

  const event: AppEvent = {
    type,
    userId,
    sequence: channel.sequence,
    at: new Date().toISOString(),
    payload,
    eventId: `${userId}:${channel.sequence}`,
  };

  for (const subscriber of channel.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      // One broken stream must not prevent delivery to the others.
      console.error(
        '[events] subscriber failed',
        type,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return event;
}

/** Current sequence for a user, so a reconnecting client can detect a gap. */
export function currentSequence(userId: string): number {
  return channels.get(userId)?.sequence ?? 0;
}

/** Number of live subscribers for a user. Used by the health endpoint. */
export function subscriberCount(userId: string): number {
  return channels.get(userId)?.subscribers.size ?? 0;
}

/** Total live subscribers across all users. */
export function totalSubscribers(): number {
  let total = 0;
  for (const channel of channels.values()) total += channel.subscribers.size;
  return total;
}

/** Serialise an event for a Server-Sent Events frame. */
export function toSseFrame(event: AppEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
