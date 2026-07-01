interface CacheOptions {
  ttl?: number; // time-to-live in milliseconds
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class BrainOptimization {
  private cache: Map<string, CacheEntry<any>> = new Map();

  /**
   * Retrieves a cached value or computes and caches it.
   * @param key - unique cache key
   * @param compute - async function to compute value if not cached
   * @param options - optional TTL in ms (default: 60000)
   */
  async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    options?: CacheOptions
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const data = await compute();
    const ttl = options?.ttl ?? 60000;
    this.cache.set(key, { data, expiresAt: Date.now() + ttl });
    return data;
  }

  /**
   * Runs multiple async tasks in parallel with a configurable concurrency limit.
   * @param tasks - array of async functions
   * @param concurrency - max number of concurrent tasks (default: 4)
   * @returns array of results in order
   */
  async runParallel<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number = 4
  ): Promise<T[]> {
    const results: T[] = [];
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < tasks.length) {
        const taskIndex = index++;
        results[taskIndex] = await tasks[taskIndex]();
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  /**
   * Clears the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Removes a specific cache entry.
   */
  invalidateCache(key: string): void {
    this.cache.delete(key);
  }
}
