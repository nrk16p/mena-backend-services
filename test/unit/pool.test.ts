import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../src/lib/pool.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('keeps input order and never runs more than `limit` at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 1, 2, 5, 1], 4, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await tick(n);
      running--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:1', '6:2', '7:5', '8:1']);
    expect(peak).toBe(4);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
  });

  it('rejects with the first error and stops starting new items', async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
        started.push(n);
        await tick(1);
        if (n === 1) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    await tick(20);
    expect(started.length).toBeLessThan(8);
  });
});
