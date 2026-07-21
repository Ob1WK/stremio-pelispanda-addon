export class TtlCache {
  constructor(ttlSeconds = 300) {
    this.ttlMs = Math.max(0, Number(ttlSeconds) || 0) * 1000;
    this.values = new Map();
    this.pending = new Map();
  }

  async getOrLoad(key, loader) {
    const hit = this.values.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    this.values.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = Promise.resolve().then(loader).then((value) => {
      if (this.ttlMs > 0) this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
