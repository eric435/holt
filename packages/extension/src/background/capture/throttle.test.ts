import { describe, expect, it } from "vitest";
import { createRateLimiter, type Clock } from "./throttle.js";

function fakeClock(): Clock & { sleeps: number[] } {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("lets the first call through immediately and spaces the rest", async () => {
    const clock = fakeClock();
    const wait = createRateLimiter(550, clock);
    await wait();
    await wait();
    await wait();
    expect(clock.sleeps).toEqual([550, 550]);
  });

  it("does not wait when calls are already far enough apart", async () => {
    const clock = fakeClock();
    const wait = createRateLimiter(500, clock);
    await wait();
    await clock.sleep(2_000);
    await wait();
    expect(clock.sleeps).toEqual([2_000]);
  });

  it("queues concurrent callers instead of letting them through together", async () => {
    // A clock that doesn't advance: all three callers arrive at the same instant.
    const sleeps: number[] = [];
    const clock: Clock = { now: () => 0, sleep: async (ms) => void sleeps.push(ms) };
    const wait = createRateLimiter(500, clock);
    await Promise.all([wait(), wait(), wait()]);
    expect(sleeps).toEqual([500, 1_000]);
  });
});
