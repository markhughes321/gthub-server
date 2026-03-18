/**
 * Simple async concurrency-limited queue.
 * Replaces the blunt parallelReviews boolean with a proper slot-based queue.
 */
type Task = () => Promise<void>;

export interface QueueItemMeta {
  repo: string;
  prNumber: number;
  title?: string;
  url?: string;
}

interface PendingEntry {
  task: Task;
  meta?: QueueItemMeta;
}

export class ReviewQueue {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly pendingEntries: PendingEntry[] = [];
  private readonly activeKeys = new Set<string>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  get active(): number { return this.activeCount; }
  get pending(): number { return this.pendingEntries.length; }
  get pendingItems(): QueueItemMeta[] {
    return this.pendingEntries.map(e => e.meta).filter((m): m is QueueItemMeta => m !== undefined);
  }

  enqueue(task: Task, meta?: QueueItemMeta): void {
    if (meta) {
      const key = `${meta.repo}#${meta.prNumber}`;
      const alreadyPending = this.pendingEntries.some(e => e.meta && `${e.meta.repo}#${e.meta.prNumber}` === key);
      if (alreadyPending || this.activeKeys.has(key)) return;
    }
    if (this.activeCount < this.maxConcurrent) {
      this.run(task, meta);
    } else {
      this.pendingEntries.push({ task, meta });
    }
  }

  private run(task: Task, meta?: QueueItemMeta): void {
    this.activeCount++;
    const key = meta ? `${meta.repo}#${meta.prNumber}` : undefined;
    if (key) this.activeKeys.add(key);
    task().finally(() => {
      this.activeCount--;
      if (key) this.activeKeys.delete(key);
      const next = this.pendingEntries.shift();
      if (next) this.run(next.task, next.meta);
    });
  }
}

// Singleton queue updated whenever config is reloaded
let _queue: ReviewQueue = new ReviewQueue(3);

export function getQueue(): ReviewQueue { return _queue; }

export function configureQueue(maxConcurrent: number): void {
  _queue = new ReviewQueue(maxConcurrent);
}
