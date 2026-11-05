export type AdvancingClock = {
  now(): Date;
  advanceSeconds(seconds: number): void;
};

export function createAdvancingClock(start: Date = new Date()): AdvancingClock {
  let current = start;
  return {
    now: () => current,
    advanceSeconds: (seconds: number) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}
