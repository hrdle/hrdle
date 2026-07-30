// Retiring the glasses app's previous run.
//
// The Even Realities app launches a new WebView without tearing down the old
// one — everything-evenhub#16 records two instances of a plugin running
// concurrently for over sixteen minutes, the stale one still holding the
// microphone. From inside a WebView neither instance can see the other, and the
// host offers no way to ask. Both of them connect here, which makes the server
// the only party that knows.
//
// The cost of the stale one is not only wasted work: while it is still counted
// as a device subscriber, notifications are routed to a panel the host has
// revoked and the browser notification that would have replaced them is
// suppressed.

import { describe, expect, test } from 'bun:test';
import {
  subscribeGlassesRelay,
  unsubscribeGlassesRelay,
  glassesDeviceCount,
  glassesRelayDeps,
  type RelaySocket,
} from '../../src/services/glasses-relay';

// No herdr RPC: the snapshot is built from workspaces, and every subscribe asks
// for one.
glassesRelayDeps.listWorkspaces = async () => [];
glassesRelayDeps.readPaneText = async () => null;

/** A socket that records what it was sent, and can pretend to be dead. */
function socket(dead = false) {
  const sent: Array<Record<string, unknown>> = [];
  const ws: RelaySocket & { sent: typeof sent } = {
    sent,
    send(data: string) {
      if (dead) throw new Error('socket closed');
      sent.push(JSON.parse(data));
    },
  };
  return ws;
}

const superseded = (ws: { sent: Array<Record<string, unknown>> }) =>
  ws.sent.filter((m) => m.type === 'glasses-superseded');

/** Each test starts from an empty subscriber set; the sets are module state. */
async function fresh(...sockets: RelaySocket[]) {
  for (const ws of sockets) unsubscribeGlassesRelay(ws);
}

describe('a newer glasses instance retires the older one', () => {
  test('the previous run is told, and stops counting as a device', async () => {
    const older = socket();
    const newer = socket();
    await subscribeGlassesRelay(older, true, 'aaaa');
    expect(glassesDeviceCount()).toBe(1);

    await subscribeGlassesRelay(newer, true, 'bbbb');

    expect(superseded(older)).toEqual([{ type: 'glasses-superseded', by: 'bbbb' }]);
    expect(superseded(newer)).toEqual([]);
    // Dropped immediately rather than when it eventually disconnects: while it
    // is counted, the server believes a wearer is being shown notifications.
    expect(glassesDeviceCount()).toBe(1);
    await fresh(older, newer);
  });

  test('a reconnect does not retire itself', async () => {
    // The same run comes back on a new socket after the phone drops the old one.
    const first = socket();
    const second = socket();
    await subscribeGlassesRelay(first, true, 'aaaa');
    await subscribeGlassesRelay(second, true, 'aaaa');
    expect(superseded(first)).toEqual([]);
    await fresh(first, second);
  });

  test('a re-subscribe on the same socket does not retire itself', async () => {
    const ws = socket();
    await subscribeGlassesRelay(ws, true, 'aaaa');
    await subscribeGlassesRelay(ws, true, 'aaaa');
    expect(superseded(ws)).toEqual([]);
    await fresh(ws);
  });

  test('the simulator is neither retired nor able to retire', async () => {
    // Testing in a browser while wearing the glasses has to keep working.
    const device = socket();
    const sim = socket();
    await subscribeGlassesRelay(device, true, 'aaaa');
    await subscribeGlassesRelay(sim, false, 'ssss');
    expect(superseded(device)).toEqual([]);

    const newer = socket();
    await subscribeGlassesRelay(newer, true, 'bbbb');
    expect(superseded(sim)).toEqual([]);
    expect(superseded(device)).toHaveLength(1);
    await fresh(device, sim, newer);
  });

  test('a run with no instanceId is left alone', async () => {
    // An ehpk older than the field cannot be told apart from the newcomer, and
    // silencing a live wearer on a guess is the worse error.
    const legacy = socket();
    const newer = socket();
    await subscribeGlassesRelay(legacy, true);
    await subscribeGlassesRelay(newer, true, 'bbbb');
    expect(superseded(legacy)).toEqual([]);
    expect(glassesDeviceCount()).toBe(2);
    await fresh(legacy, newer);
  });

  test('an already-dead previous socket is dropped rather than throwing', async () => {
    const dead = socket(true);
    const newer = socket();
    await subscribeGlassesRelay(dead, true, 'aaaa').catch(() => {});
    await subscribeGlassesRelay(newer, true, 'bbbb');
    expect(glassesDeviceCount()).toBe(1);
    await fresh(dead, newer);
  });

  test('three runs in a row leave only the last', async () => {
    const a = socket();
    const b = socket();
    const c = socket();
    await subscribeGlassesRelay(a, true, 'aaaa');
    await subscribeGlassesRelay(b, true, 'bbbb');
    await subscribeGlassesRelay(c, true, 'cccc');
    expect(superseded(a)).toEqual([{ type: 'glasses-superseded', by: 'bbbb' }]);
    expect(superseded(b)).toEqual([{ type: 'glasses-superseded', by: 'cccc' }]);
    expect(superseded(c)).toEqual([]);
    expect(glassesDeviceCount()).toBe(1);
    await fresh(a, b, c);
  });
});
