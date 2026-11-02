import { Queue } from '@forge/events';
import { runMigrations } from '../adapters/sql';

export const EXTRACT_QUEUE = 'extract';
export const EVALUATE_QUEUE = 'evaluate';

const extractQueue = new Queue({ key: EXTRACT_QUEUE });

interface PageEvent {
  eventType?: string;
  content?: { id?: string; type?: string };
}

/** Confluence page created/updated → enqueue extraction (LLM work runs only in the consumer). */
export async function onPageEvent(event: PageEvent): Promise<void> {
  const pageId = event.content?.id;
  if (!pageId) return;
  await extractQueue.push({ body: { pageId, eventType: event.eventType ?? 'unknown' } });
}

/** Daily: apply pending migrations, then fan out evaluation batches (stub: nothing to evaluate yet). */
export async function scheduleEvaluation(): Promise<void> {
  await runMigrations();
}

interface QueueEvent {
  body?: Record<string, unknown>;
}

/** Consumer for the `extract` queue. Stub until the extraction prompt is written. */
export async function extractDecision(event: QueueEvent): Promise<void> {
  const pageId = event.body?.pageId;
  if (typeof pageId !== 'string') throw new Error('extract event is missing pageId');
}

/** Consumer for the `evaluate` queue. Stub until tripwires are stored. */
export async function evaluateBatch(event: QueueEvent): Promise<void> {
  const ids = event.body?.tripwireIds;
  if (ids !== undefined && !Array.isArray(ids)) throw new Error('evaluate event tripwireIds must be an array');
}
