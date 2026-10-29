/** Serial queue with dedupe by key: the same HEAD is never reviewed twice (GitHub redelivers webhooks). */
export class ReviewQueue<T> {
  private readonly seen = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly worker: (job: T) => Promise<void>, private readonly maxSeen = 2000) {}

  /** false = already seen, ignored. */
  push(key: string, job: T): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.maxSeen) this.seen.delete(this.seen.values().next().value as string);
    this.tail = this.tail.then(() => this.worker(job)).catch((error) => {
      console.error(`[pr-reviewer] ${key}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
