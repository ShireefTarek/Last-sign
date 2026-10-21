export interface RandomDraw {
  value: number;
  state: number;
}

/** Mulberry32 step. The seed is server-generated and stays in server state. */
export function nextRandom(state: number): RandomDraw {
  let next = (state + 0x6d2b79f5) >>> 0;
  let value = next;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  value = (value ^ (value >>> 14)) >>> 0;
  return { value: value / 0x1_0000_0000, state: next };
}

export function deterministicShuffle<T>(items: readonly T[], seed: number): { items: T[]; state: number } {
  const shuffled = [...items];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const draw = nextRandom(state);
    state = draw.state;
    const target = Math.floor(draw.value * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return { items: shuffled, state };
}
