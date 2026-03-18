/**
 * Simple async concurrency-limited queue.
 * Replaces the blunt parallelReviews boolean with a proper slot-based queue.
 */
type Task = () => Promise<void>;

export class ReviewQueue {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly pendingTasks: Task[] = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  get active(): number { return this.activeCount; }
  get pending(): number { return this.pendingTasks.length; }

  enqueue(task: Task): void {
    if (this.activeCount < this.maxConcurrent) {
      this.run(task);
    } else {
      this.pendingTasks.push(task);
    }
  }

  private run(task: Task): void {
    this.activeCount++;
    task().finally(() => {
      this.activeCount--;
      const next = this.pendingTasks.shift();
      if (next) this.run(next);
    });
  }
}

// Singleton queue updated whenever config is reloaded
let _queue: ReviewQueue = new ReviewQueue(3);

export function getQueue(): ReviewQueue { return _queue; }

export function configureQueue(maxConcurrent: number): void {
  _queue = new ReviewQueue(maxConcurrent);
}
