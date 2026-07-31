export type ScopedRequestToken = {
  key: string;
  generation: number;
};

export class ScopedRequestGate {
  private readonly generations = new Map<string, number>();

  begin(key: string): ScopedRequestToken {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return { key, generation };
  }

  invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  isCurrent(token: ScopedRequestToken): boolean {
    return this.generations.get(token.key) === token.generation;
  }
}
