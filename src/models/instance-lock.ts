import { ConcurrencyError } from './errors';

/** Per-instance exclusive lock for synchronous mutations (same-process). */
export class InstanceLockManager {
  private locked = new Set<string>();

  runExclusive<T>(instanceId: string, fn: () => T): T {
    if (this.locked.has(instanceId)) {
      throw new ConcurrencyError(instanceId);
    }
    this.locked.add(instanceId);
    try {
      return fn();
    } finally {
      this.locked.delete(instanceId);
    }
  }
}
