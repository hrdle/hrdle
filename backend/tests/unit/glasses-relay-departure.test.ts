// Recording the moment a glasses run goes away.
//
// The app announces its own exit when the host gives it the chance, and for
// thirteen of nineteen runs on 2026-07-31 it did. The other five were killed
// too abruptly to say anything: the heartbeat simply stopped, no `host exit`
// line, no event. Nothing surfaced them at the time — each was found later by
// reading the log and inferring death from silence, which reads exactly like a
// log that is lagging. That confusion nearly had a live run declared dead the
// same morning.
//
// The socket closing is a fact rather than an inference, and the server is the
// only party still watching once the WebView is gone. So `unsubscribeGlassesRelay`
// reports what it dropped, and `muxClose` writes it down.

import { describe, expect, test } from 'bun:test';
import {
  subscribeGlassesRelay,
  unsubscribeGlassesRelay,
  glassesDeviceCount,
  glassesRelaySubscriberCount,
  glassesRelayDeps,
  type RelaySocket,
} from '../../src/services/glasses-relay';

glassesRelayDeps.listWorkspaces = async () => [];
glassesRelayDeps.readPaneText = async () => null;

function socket(): RelaySocket {
  return { send() {} };
}

describe('a departing subscription says what it was', () => {
  test('a device reports itself and its run id', async () => {
    const ws = socket();
    await subscribeGlassesRelay(ws, true, 'a147');
    const departed = unsubscribeGlassesRelay(ws);
    expect(departed).toEqual({ onDevice: true, instanceId: 'a147' });
  });

  test('an ehpk too old to send a run id still reports the device', async () => {
    // `instanceId` arrived with the retirement work; a build from before it
    // subscribes without one, and the departure is still worth recording.
    const ws = socket();
    await subscribeGlassesRelay(ws, true);
    expect(unsubscribeGlassesRelay(ws)).toEqual({ onDevice: true });
  });

  test('the simulator is not a device', async () => {
    // It subscribes with onDevice false and no hardware went anywhere when its
    // tab closes, so logging it as a glasses run ending would be a lie.
    const ws = socket();
    await subscribeGlassesRelay(ws, false, 'sim1');
    expect(unsubscribeGlassesRelay(ws)).toEqual({ onDevice: false });
  });

  test('an ordinary browser socket reports nothing at all', () => {
    // Every mux connection passes through here on close. Only the ones that
    // were subscribed are glasses going away.
    expect(unsubscribeGlassesRelay(socket())).toBeNull();
  });

  test('unsubscribing twice reports nothing the second time', async () => {
    // `muxClose` runs after an explicit `unsubscribe-glasses-relay`, so the
    // second call must not produce a second departure for one run.
    const ws = socket();
    await subscribeGlassesRelay(ws, true, 'dupe');
    expect(unsubscribeGlassesRelay(ws)?.instanceId).toBe('dupe');
    expect(unsubscribeGlassesRelay(ws)).toBeNull();
  });
});

describe('reporting does not change what unsubscribing does', () => {
  test('the socket is gone from both sets and the counts follow', async () => {
    const ws = socket();
    const before = glassesRelaySubscriberCount();
    await subscribeGlassesRelay(ws, true, 'gone');
    expect(glassesRelaySubscriberCount()).toBe(before + 1);
    expect(glassesDeviceCount()).toBeGreaterThan(0);
    unsubscribeGlassesRelay(ws);
    expect(glassesRelaySubscriberCount()).toBe(before);
  });

  test('one device leaving does not take another with it', async () => {
    const staying = socket();
    const leaving = socket();
    await subscribeGlassesRelay(staying, true, 'stay');
    await subscribeGlassesRelay(leaving, true, 'stay');
    const devices = glassesDeviceCount();
    unsubscribeGlassesRelay(leaving);
    expect(glassesDeviceCount()).toBe(devices - 1);
  });
});
