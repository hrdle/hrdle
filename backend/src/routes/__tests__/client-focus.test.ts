import { describe, expect, test } from 'bun:test';
import {
  applyClientInfoFocus,
  applySubscribeFocus,
  pickClientFocus,
  type MuxData,
} from '../terminal-mux';

/**
 * The glasses follow the session open on the screen a person is looking at, so
 * that moving yourself moves them. Which screen that is has to be decided here,
 * because a wrong answer does not merely mislead - in a conversation the
 * glasses re-subscribe and clear what is on show, and a wearer mid-paragraph
 * loses it.
 */

/** Any clock will do; the code only ever reads differences from it. */
const NOW = 1_000_000;

function client(over: Partial<MuxData> = {}): MuxData {
  return {
    deviceType: 'desktop',
    visible: true,
    focusSessionId: 's1',
    focusAt: 1,
    lastPingAt: NOW,
    ...over,
  } as MuxData;
}

describe('pickClientFocus', () => {
  test('the visible client that claimed most recently wins', () => {
    const focus = pickClientFocus(
      [
        client({ focusSessionId: 'old', focusAt: 1 }),
        client({ focusSessionId: 'new', focusAt: 2, deviceType: 'mobile' }),
      ],
      NOW,
    );
    expect(focus).toEqual({ sessionId: 'new', deviceType: 'mobile', at: 2 });
  });

  test('a pocketed or undeclared client claims nothing', () => {
    expect(pickClientFocus([client({ visible: false })], NOW)).toBeUndefined();
    expect(pickClientFocus([client({ visible: undefined })], NOW)).toBeUndefined();
    expect(pickClientFocus([client({ deviceType: undefined })], NOW)).toBeUndefined();
  });

  /** Following its own focus would be a feedback loop. */
  test('the glasses do not claim the focus they follow', () => {
    expect(pickClientFocus([client({ isGlasses: true } as Partial<MuxData>)], NOW)).toBeUndefined();
  });

  /**
   * A browser being driven is not a screen anyone is looking at. This machine
   * runs several agents that open the web UI headlessly to take screenshots,
   * and each of them claimed the focus: a wearer reading one conversation was
   * carried into a workspace they had never touched, three times in one
   * recording, with every gesture of their own somewhere else.
   */
  test('a driven browser claims nothing', () => {
    expect(pickClientFocus([client({ automated: true })], NOW)).toBeUndefined();
  });

  test('and does not outbid a real one by being newer', () => {
    const focus = pickClientFocus(
      [
        client({ focusSessionId: 'phone', focusAt: 1, deviceType: 'mobile' }),
        client({ focusSessionId: 'robot', focusAt: 99, automated: true }),
      ],
      NOW,
    );
    expect(focus?.sessionId).toBe('phone');
  });

  /**
   * A desktop someone is sitting at is still a person. Only automation is
   * excluded - the device type says where you are, not whether you are there.
   */
  test('a desktop is followed like any other screen', () => {
    expect(pickClientFocus([client({ deviceType: 'desktop' })], NOW)?.deviceType).toBe('desktop');
  });

  test('nobody connected means nobody to follow', () => {
    expect(pickClientFocus([], NOW)).toBeUndefined();
  });
});

/**
 * A lid closing does not clear `visible`, and the socket outlives the machine
 * being awake by up to 90 seconds. Measured on 2026-08-10: a Mac woke, its
 * restored tab claimed w4H, and 51 seconds later the G2 left the conversation
 * the wearer was reading for a workspace finished days before - 17 such claims
 * that day, some at 00:08 and 01:19, all from a shut lid.
 */
describe('a claim needs a heartbeat behind it', () => {
  test('a client that stopped pinging drops out of the election', () => {
    const asleep = client({ lastPingAt: NOW - 26_000 });
    expect(pickClientFocus([asleep], NOW)).toBeUndefined();
  });

  test('and cannot outbid a live client by having claimed later', () => {
    const focus = pickClientFocus(
      [
        client({ focusSessionId: 'phone', focusAt: 1, deviceType: 'mobile' }),
        client({ focusSessionId: 'asleep', focusAt: 99, lastPingAt: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(focus?.sessionId).toBe('phone');
  });

  /** Two missed beats is the budget; one is ordinary jitter. */
  test('a beat late is still someone at the screen', () => {
    expect(pickClientFocus([client({ lastPingAt: NOW - 11_000 })], NOW)?.sessionId).toBe('s1');
  });

  /**
   * The claim itself is not what goes stale. A client that opened a session an
   * hour ago and has been pinging ever since is a screen someone is at.
   */
  test('an old claim from a client still present is followed', () => {
    const focus = pickClientFocus([client({ focusAt: NOW - 3_600_000 })], NOW);
    expect(focus?.sessionId).toBe('s1');
  });
});

describe('a reconnect is not a person', () => {
  /**
   * The election picks the most recently raised screen. A client replays its
   * subscription whenever its socket comes back, and that replay used to count
   * as raising the screen - so a tablet left open on a desk took the wearer off
   * the session they were talking to every time the network hiccuped. Measured
   * on 2026-08-08: 44 switches to one session in a day, every one of them from
   * a device nobody had touched.
   */
  test('a resumed subscribe records the session but does not claim', () => {
    const data = { focusSessionId: 'w66', focusAt: 100 };
    applySubscribeFocus(data, { sessionId: 'w54', resumed: true }, 999);
    expect(data.focusSessionId).toBe('w54');
    expect(data.focusAt).toBe(100);
  });

  test('a person opening a session claims it', () => {
    const data = { focusSessionId: 'w66', focusAt: 100 };
    applySubscribeFocus(data, { sessionId: 'w54' }, 999);
    expect(data.focusAt).toBe(999);
  });

  test('the phone in your hand outbids the tablet that reconnected', () => {
    const tablet = { focusSessionId: 'w54', focusAt: 100, deviceType: 'tablet' as const, visible: true };
    const phone = { focusSessionId: 'w66', focusAt: 200, deviceType: 'mobile' as const, visible: true };
    applySubscribeFocus(tablet, { sessionId: 'w54', resumed: true }, 999);
    expect(pickClientFocus([client(tablet), client(phone)], NOW)?.sessionId).toBe('w66');
  });

  /**
   * A page declares itself the moment its subscription is confirmed, so this
   * message arrives one behind the resumed subscribe above - on a socket with
   * no memory of the device it belongs to. Every reconnect therefore read as
   * hidden -> visible and re-claimed what the subscribe had just declined.
   * Measured on 2026-08-11 with the heartbeat fix running: nine claims from one
   * desktop and eight from one phone, none of them touched.
   */
  test('a page re-declaring itself on a new socket does not claim', () => {
    const data: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(data, { visible: true }, { visible: true }, 999);
    expect(data.focusAt).toBeUndefined();
  });

  test('a device nobody has seen before claims when it appears', () => {
    const data: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(data, { visible: true }, undefined, 999);
    expect(data.focusAt).toBe(999);
  });

  /** Putting a device down and picking it back up is a person, either side of
   *  a reconnect: the memory is what tells the two apart. */
  test('picking a device up claims it', () => {
    const onTheSameSocket = { visible: false, focusAt: 100 };
    applyClientInfoFocus(onTheSameSocket, { visible: true }, { visible: false }, 999);
    expect(onTheSameSocket.focusAt).toBe(999);

    const afterAReconnect: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(afterAReconnect, { visible: true }, { visible: false }, 999);
    expect(afterAReconnect.focusAt).toBe(999);
  });

  test('going hidden claims nothing and is remembered as such', () => {
    const data = { visible: true, focusAt: 100 };
    applyClientInfoFocus(data, { visible: false }, { visible: true }, 999);
    expect(data).toEqual({ visible: false, focusAt: 100 });
  });
});

/**
 * The last hole the two fixes above left open. A machine that is merely awake
 * is not a person, and while it was the only one connected it won the election
 * unopposed: the recording for 2026-08-11 is a laptop taking the wearer to w4H
 * - a workspace finished days earlier - nine times between 08:51 and 13:07,
 * every one of them in a window where no other screen was declaring itself.
 */
describe('an election needs someone to have done something', () => {
  test('a reconnected client with no claim of its own is not followed', () => {
    const reconnected = client({ focusAt: undefined });
    expect(pickClientFocus([reconnected], NOW)).toBeUndefined();
  });

  /** Nothing qualifying is not the same as nothing to show: followers hold
   *  what they have rather than being carried somewhere nobody asked for. */
  test('so the glasses hold what they were showing', () => {
    const laptop = {
      deviceType: 'desktop' as const,
      focusSessionId: 'w4H',
      visible: undefined,
      focusAt: undefined,
    };
    applyClientInfoFocus(laptop, { visible: true }, { visible: true }, NOW);
    expect(pickClientFocus([client(laptop)], NOW)).toBeUndefined();
  });

  test('and one act on that same client brings it straight back', () => {
    const laptop = {
      deviceType: 'desktop' as const,
      focusSessionId: 'w4H',
      visible: undefined,
      focusAt: undefined,
    };
    applyClientInfoFocus(laptop, { visible: true }, { visible: true }, NOW);
    applySubscribeFocus(laptop, { sessionId: 'w4H' }, NOW);
    expect(pickClientFocus([client(laptop)], NOW)?.sessionId).toBe('w4H');
  });
});
