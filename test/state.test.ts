import { describe, expect, it } from 'vitest';
import { nextState, STRIKES_TO_TRIP } from '../src/core/state';
import type { EvaluationOutcome, TripwireStatus } from '../src/core/types';

describe('nextState rule table', () => {
  const cases: [TripwireStatus, number, EvaluationOutcome, TripwireStatus, number, boolean][] = [
    ['active', 0, 'safe', 'active', 0, false],
    ['near', 1, 'safe', 'active', 0, false],
    ['active', 0, 'near', 'near', 0, false],
    ['near', 1, 'near', 'near', 0, false],
    ['active', 0, 'tripped', 'near', 1, false],
    ['near', 0, 'tripped', 'near', 1, false],
    ['active', 1, 'tripped', 'tripped', 2, true],
    ['near', 1, 'tripped', 'tripped', 2, true],
    ['tripped', 2, 'tripped', 'tripped', 3, true],
    ['tripped', 2, 'safe', 'active', 0, false],
    ['tripped', 2, 'near', 'near', 0, false],
    ['revisiting', 2, 'tripped', 'revisiting', 3, false],
    ['revisiting', 2, 'near', 'revisiting', 0, false],
    ['revisiting', 2, 'safe', 'revisiting', 0, false],
  ];

  it.each(cases)('%s (strikes %i) + %s → %s (strikes %i, openRevisit %s)', (status, strikes, outcome, next, nextStrikes, open) => {
    expect(nextState({ status, strikes }, outcome)).toEqual({ status: next, strikes: nextStrikes, openRevisit: open });
  });

  it.each(['proposed', 'archived'] as const)('throws for %s', (status) => {
    expect(() => nextState({ status, strikes: 0 }, 'tripped')).toThrow('not evaluable');
  });
});

describe('nextState sequences', () => {
  it('needs two consecutive tripped readings, then stays put while revisiting', () => {
    let s = nextState({ status: 'active', strikes: 0 }, 'safe');
    expect(s).toEqual({ status: 'active', strikes: 0, openRevisit: false });
    s = nextState(s, 'near');
    expect(s).toEqual({ status: 'near', strikes: 0, openRevisit: false });
    s = nextState(s, 'tripped');
    expect(s).toEqual({ status: 'near', strikes: 1, openRevisit: false });
    s = nextState(s, 'tripped');
    expect(s).toEqual({ status: 'tripped', strikes: STRIKES_TO_TRIP, openRevisit: true });
    s = nextState({ status: 'revisiting', strikes: s.strikes }, 'tripped');
    expect(s).toEqual({ status: 'revisiting', strikes: 3, openRevisit: false });
  });

  it('a safe reading after tripping resets to active with zero strikes', () => {
    const tripped = nextState({ status: 'near', strikes: 1 }, 'tripped');
    expect(nextState(tripped, 'safe')).toEqual({ status: 'active', strikes: 0, openRevisit: false });
  });

  it('a single spike between safe readings never trips', () => {
    let s = nextState({ status: 'active', strikes: 0 }, 'tripped');
    s = nextState(s, 'safe');
    s = nextState(s, 'tripped');
    expect(s).toEqual({ status: 'near', strikes: 1, openRevisit: false });
  });
});
