/**
 * Sends a thread's finished turns through the TypeScript SDK, one export
 * each: a turn sent again — after a hook that died before saving that it had
 * sent it — is then the same bytes, which ingest answers once.
 */

import { Telmoni } from 'telmoni';
import type { RunRecord } from 'telmoni';

import { MAX_CALLS } from './record.js';

/** How long one turn's export may take, its retries included; and each export more, past its first. */
const FLUSH_SECONDS = 45;
const FLUSH_SECONDS_PER_EXPORT = 15;
/** The SDK's own batch: well inside ingest's caps on an export, 1,000 spans and a mebibyte. */
const BATCH_SPANS = 512;
/** A record is queued whole: the run, its start and every call, past the SDK's own 2,048. */
const QUEUE_SPANS = MAX_CALLS + 2;
/** How the SDK opens a warning of what the platform answered of an export it took, rather than of one it could not deliver. */
const ANSWERED = 'telmoni: the server ';

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

export class Sender {
  readonly #telmoni: Telmoni;
  readonly #warnings: string[] = [];
  readonly #log: (line: string) => void;

  constructor(destination: Destination, log: (line: string) => void) {
    this.#log = log;
    this.#telmoni = new Telmoni(
      { endpoint: destination.endpoint, apiKey: destination.apiKey },
      {
        warn: (message) => void this.#warnings.push(message),
        processor: { maxQueueSize: QUEUE_SPANS, maxBatchSize: BATCH_SPANS },
      },
    );
  }

  /**
   * Whether the platform took the turn. The SDK warns of every export it
   * could not deliver, and of all the platform answered it did not keep, and
   * its warnings never carry a session's content. A turn counts as taken
   * once its flush settles with no warning but the platform's own answer — a
   * span refused, an attribute dropped — which the same bytes would get on
   * every hook: it is logged, and, as a record the SDK refuses, must not hold
   * up the turns after it.
   */
  async send(record: RunRecord): Promise<boolean> {
    try {
      this.#telmoni.recordRun(record);
    } catch (error) {
      this.#log(`turn refused by the SDK: ${error instanceof Error ? error.name : typeof error}`);
      return true;
    }
    const exports = Math.ceil(((record.inside?.length ?? 0) + 2) / BATCH_SPANS);
    const flushed = await this.#telmoni.flush(FLUSH_SECONDS + (exports - 1) * FLUSH_SECONDS_PER_EXPORT);
    // This turn's alone: the warnings of a turn taken before it are not its own.
    const warnings = this.#warnings.splice(0);
    if (!flushed) {
      this.#log('not sent: the export did not finish in time');
      return false;
    }
    const failures = warnings.filter((warning) => !warning.startsWith(ANSWERED));
    if (failures.length > 0) {
      this.#log(`not sent: ${failures.join('; ')}`);
      return false;
    }
    if (warnings.length > 0) this.#log(`taken, but ${warnings.join('; ')}`);
    return true;
  }

  close(): Promise<void> {
    return this.#telmoni.shutdown();
  }
}
