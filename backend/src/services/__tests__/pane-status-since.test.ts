import { describe, expect, it } from 'bun:test';
import { PaneStatusClock } from '../pane-status-since';

describe('PaneStatusClock', () => {
  it('has no time for a state it did not see begin', () => {
    const clock = new PaneStatusClock();
    expect(clock.observe('a', 'working', 1000)).toBeNull();
    expect(clock.observe('a', 'working', 2000)).toBeNull();
  });

  it('dates a state from the poll that first saw it change', () => {
    const clock = new PaneStatusClock();
    clock.observe('a', 'working', 1000);
    expect(clock.observe('a', 'done', 5000)).toBe(5000);
    expect(clock.observe('a', 'done', 9000)).toBe(5000);
    expect(clock.observe('a', 'idle', 12000)).toBe(12000);
  });

  it('keeps panes apart', () => {
    const clock = new PaneStatusClock();
    clock.observe('a', 'working', 1000);
    clock.observe('b', 'working', 1000);
    expect(clock.observe('a', 'idle', 2000)).toBe(2000);
    expect(clock.observe('b', 'working', 3000)).toBeNull();
  });

  it('says nothing for a pane with no status', () => {
    const clock = new PaneStatusClock();
    expect(clock.observe('a', undefined, 1000)).toBeNull();
  });

  it('forgets a pane that has gone, so a reused id starts over', () => {
    const clock = new PaneStatusClock();
    clock.observe('a', 'working', 1000);
    clock.observe('a', 'idle', 2000);
    clock.retain(new Set(['b']));
    expect(clock.observe('a', 'idle', 9000)).toBeNull();
  });
});
