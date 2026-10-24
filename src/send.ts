/**
 * Sends a thread's finished turns through the TypeScript SDK, one export each: a turn sent again, after a hook that
 * died before saving that it had, is the same bytes, which ingest stores once within the hour.
 */

import { Telmoni } from 'telmoni';
import type { RunRecord } from 'telmoni';

import { MAX_CALLS } from './record.js';

/** The SDK's batch, which it sends one at a time: well inside ingest's caps on an export, 1,000 spans and a mebibyte. */
const BATCH_SPANS = 512;
/** How often the SDK tries a batch before it drops it; it exports none of the limits restated here. */
const ATTEMPTS = 3;
/** How long the SDK gives each attempt. */
const ATTEMPT_SECONDS = 10;
/** The longest `Retry-After` the SDK waits out between two attempts. */
const RETRY_AFTER_SECONDS = 60;
/** A batch's worst case, 150 seconds: every attempt timed out, with the longest wait between each two. */
const BATCH_SECONDS = ATTEMPTS * ATTEMPT_SECONDS + (ATTEMPTS - 1) * RETRY_AFTER_SECONDS;
/** Beyond the batches' worst case, so a turn's flush ends on the platform's answer rather than before it. */
const FLUSH_MARGIN_SECONDS = 30;
/** A record is queued whole: the run, its start and every call, past the SDK's own 2,048. */
const QUEUE_SPANS = MAX_CALLS + 2;
/**
 * The SDK's warnings of spans it could not deliver, which a later hook may yet get through: Telmoni out of reach or busy
 * past its retries, or a key or an endpoint it refused. Every other warning is of bytes delivered, or refused for good.
 */
const UNDELIVERED = /^telmoni: (?:export failed after |an export failed \(|the export queue was full|export refused with (?!400 |402 |413 |500 ))/;
/** Ingest's `500` for a fault of its database, which a later hook may find mended, as it would none of its other `500`s. */
const DATABASE_FAILED = /^telmoni: export refused with 500 \/errors\/internal\/database;/;
/** An export refused for good: for what it holds (`400`, `413`), a fault of ingest's own (any other `500`), an organization paused (`402`). */
const REFUSED = /^telmoni: export refused with (?:400|402|413|500) /;

/** How long a turn's flush may take: the SDK's worst case for each of its batches, and a margin. */
export function flushSecondsOf(record: RunRecord): number {
  return FLUSH_MARGIN_SECONDS + Math.ceil(((record.inside?.length ?? 0) + 2) / BATCH_SPANS) * BATCH_SECONDS;
}

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

interface Client {
  telmoni: Telmoni;
  warnings: string[];
}

function clientOf(destination: Destination): Client {
  const warnings: string[] = [];
  const telmoni = new Telmoni(
    { endpoint: destination.endpoint, apiKey: destination.apiKey },
    {
      warn: (message) => void warnings.push(message),
      processor: { maxQueueSize: QUEUE_SPANS, maxBatchSize: BATCH_SPANS },
    },
  );
  return { telmoni, warnings };
}

export class Sender {
  readonly #destination: Destination;
  readonly #log: (line: string) => void;
  /** The first turn's client, made with the sender so the SDK refuses an endpoint before any turn is read. */
  #first: Client | undefined;

  constructor(destination: Destination, log: (line: string) => void) {
    this.#destination = destination;
    this.#log = log;
    this.#first = clientOf(destination);
  }

  /**
   * Whether the turn is done with: taken, whole or in part, or refused for good, which the same bytes would get on every
   * hook. The SDK's warnings, logged as they are, never carry anything of the session.
   */
  async send(record: RunRecord): Promise<boolean> {
    // A client of its own: the SDK warns of each kind once a client, and a turn refused as one before it, unwarned, would read as taken.
    const { telmoni, warnings } = this.#first ?? clientOf(this.#destination);
    this.#first = undefined;
    try {
      try {
        telmoni.recordRun(record);
      } catch (error) {
        this.#log(`turn refused by the SDK: ${error instanceof Error ? error.name : typeof error}`);
        return true;
      }
      if (!(await telmoni.flush(flushSecondsOf(record)))) {
        this.#log('not sent: the export did not finish in time');
        return false;
      }
      const failures = warnings.filter((warning) => UNDELIVERED.test(warning) || DATABASE_FAILED.test(warning));
      if (failures.length > 0) {
        this.#log(`not sent: ${failures.join('; ')}`);
        return false;
      }
      if (warnings.some((warning) => REFUSED.test(warning))) this.#log(`refused, not sent again: ${warnings.join('; ')}`);
      else if (warnings.length > 0) this.#log(`taken in part: ${warnings.join('; ')}`);
      return true;
    } finally {
      await telmoni.shutdown();
    }
  }

  async close(): Promise<void> {
    await this.#first?.telmoni.shutdown();
  }
}
