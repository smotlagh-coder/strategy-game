import { describe, expect, it } from 'vitest';
import { applyBalanceProfile, CURRENT_PROFILE } from '../data/balance';
import { compareSuites } from './balanceSim';

describe('balance simulation', () => {
  it('live pack stays more even than legacy without going pointless', () => {
    const { legacy, current } = compareSuites(400, 2026);
    applyBalanceProfile(CURRENT_PROFILE);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          legacy: {
            avgCitiesDestroyed: +legacy.avgCitiesDestroyed.toFixed(2),
            pointlessShare: +legacy.pointlessShare.toFixed(3),
            winGap: +legacy.winGap.toFixed(1),
            winRate: Object.fromEntries(
              Object.entries(legacy.winRate).map(([k, v]) => [k, +v.toFixed(1)]),
            ),
          },
          current: {
            avgCitiesDestroyed: +current.avgCitiesDestroyed.toFixed(2),
            pointlessShare: +current.pointlessShare.toFixed(3),
            winGap: +current.winGap.toFixed(1),
            winRate: Object.fromEntries(
              Object.entries(current.winRate).map(([k, v]) => [k, +v.toFixed(1)]),
            ),
          },
        },
        null,
        2,
      ),
    );

    expect(current.avgCitiesDestroyed).toBeGreaterThan(2);
    expect(current.pointlessShare).toBeLessThanOrEqual(legacy.pointlessShare + 0.05);
    for (const [name, rate] of Object.entries(current.winRate)) {
      expect(rate, name).toBeLessThan(50);
    }
    expect(current.avgRounds).toBeGreaterThanOrEqual(5);
  });
});
