import { describe, expect, test } from 'bun:test';
import {
  applyClientInfoFocus,
  applySubscribeFocus,
  describeDeclaration,
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
   * no past to compare against. Every reconnect therefore read as
   * hidden -> visible and re-claimed what the subscribe had just declined.
   */
  test('a page re-declaring itself on a new socket does not claim', () => {
    const data: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(data, { visible: true }, 999);
    expect(data.focusAt).toBeUndefined();
  });

  /**
   * v0.3.93 told the two apart with a per-device memory on the server, and a
   * server restart emptied it - so every client reconnecting after a deploy
   * looked brand new. Ten minutes after the 0.3.94 restart, on 2026-08-12, a
   * laptop nobody had touched took the wearer to a workspace finished five days
   * earlier. Only the page knows it was opened; it now says so.
   */
  test('a page someone just opened claims', () => {
    const data: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(data, { visible: true, fresh: true }, 999);
    expect(data.focusAt).toBe(999);
  });

  /** A tab open since before `fresh` shipped is the very tab this is about. */
  test('a client too old to say either way does not claim', () => {
    const data: { visible?: boolean; focusAt?: number } = {};
    applyClientInfoFocus(data, { visible: true }, 999);
    expect(data.focusAt).toBeUndefined();
  });

  /** Putting a device down and picking it back up is a person - and it happens
   *  on a live connection, so it needs nothing remembered to be seen. */
  test('picking a device up claims it', () => {
    const data = { visible: false, focusAt: 100 };
    applyClientInfoFocus(data, { visible: true }, 999);
    expect(data.focusAt).toBe(999);
  });

  test('going hidden claims nothing', () => {
    const data = { visible: true, focusAt: 100 };
    applyClientInfoFocus(data, { visible: false }, 999);
    expect(data).toEqual({ visible: false, focusAt: 100 });
  });
});

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
    applyClientInfoFocus(laptop, { visible: true }, NOW);
    expect(pickClientFocus([client(laptop)], NOW)).toBeUndefined();
  });

  test('and one act on that same client brings it straight back', () => {
    const laptop = {
      deviceType: 'desktop' as const,
      focusSessionId: 'w4H',
      visible: undefined,
      focusAt: undefined,
    };
    applyClientInfoFocus(laptop, { visible: true }, NOW);
    applySubscribeFocus(laptop, { sessionId: 'w4H' }, NOW);
    expect(pickClientFocus([client(laptop)], NOW)?.sessionId).toBe('w4H');
  });
});

/**
 * A wearer picking a session with the ring is the most recent thing a person
 * did, and until now it lost to a tablet sitting visible on a desk: the glasses
 * were excluded from the election wholesale, because the subscriptions they
 * make while *following* it would otherwise feed back into it. Two different
 * acts were being refused together. The app now says which one it is doing.
 */
describe('a ring selection claims the focus', () => {
  /** What the app sends on a tap: `glasses-focus`, handled in the mux route. */
  function ringPick(sessionId: string, at: number): Partial<MuxData> {
    return { isGlasses: true, glassesFocusSessionId: sessionId, glassesFocusAt: at };
  }

  test('the wearer outbids a tablet that claimed earlier', () => {
    const tablet = client({ focusSessionId: 'w54', focusAt: 100, deviceType: 'tablet' });
    const glasses = client(ringPick('w66', 200) as Partial<MuxData>);
    expect(pickClientFocus([tablet, glasses], NOW)).toEqual({
      sessionId: 'w66',
      deviceType: 'glasses',
      at: 200,
    });
  });

  /** Last writer still wins: a tablet picked up afterwards is a person too. */
  test('but not one raised after the pick', () => {
    const glasses = client(ringPick('w66', 100) as Partial<MuxData>);
    const tablet = client({ focusSessionId: 'w54', focusAt: 200, deviceType: 'tablet' });
    expect(pickClientFocus([glasses, tablet], NOW)?.sessionId).toBe('w54');
  });

  /**
   * The feedback loop this whole separation exists to prevent. Following the
   * focus makes the app subscribe, and a subscribe writes `focusAt` on any
   * connection - so if the election read that field on a glasses connection,
   * every follow would re-claim as the wearer and the glasses would hold the
   * focus against every other screen forever.
   */
  test('following a focus is not picking one', () => {
    const followed = client({
      isGlasses: true,
      focusSessionId: 'w54',
      focusAt: NOW,
    } as Partial<MuxData>);
    expect(pickClientFocus([followed], NOW)).toBeUndefined();
  });

  test('and a claim survives the follows that come after it', () => {
    const glasses = client({
      ...ringPick('w66', 100),
      // The subscribe the app makes on being sent elsewhere, later than the pick.
      focusSessionId: 'w54',
      focusAt: 300,
    } as Partial<MuxData>);
    expect(pickClientFocus([glasses], NOW)?.sessionId).toBe('w66');
  });

  /** Same rule as every other candidate: a socket nobody is behind drops out. */
  test('a pick from glasses that stopped pinging drops out', () => {
    const glasses = client({ ...ringPick('w66', 100), lastPingAt: NOW - 60_000 } as Partial<MuxData>);
    expect(pickClientFocus([glasses], NOW)).toBeUndefined();
  });

  /**
   * The budget is two and a half beats, and the glasses beat at 15s rather than
   * a browser's 10s. Counted in the browser's number it was one beat and two
   * thirds, so a single dropped ping handed the focus straight back to the
   * tablet this feature exists to outbid - over BLE through the phone, which is
   * the least reliable leg any client has.
   */
  test('one dropped ping does not undo the pick', () => {
    const glasses = client({ ...ringPick('w66', 100), lastPingAt: NOW - 30_000 } as Partial<MuxData>);
    expect(pickClientFocus([glasses], NOW)?.sessionId).toBe('w66');
  });

  test('a browser is still held to its own faster beat', () => {
    const tablet = client({ deviceType: 'tablet', lastPingAt: NOW - 30_000 });
    expect(pickClientFocus([tablet], NOW)).toBeUndefined();
  });
});

/**
 * A claim is logged where it is minted, and nothing was logged when a client
 * merely arrived - so a quiet log meant either "it came back and declined to
 * claim" or "it never came back", and the two could not be told apart. That
 * distinction is the whole of the verification: three fixes to this election
 * were judged on the absence of a symptom, and one was declared fixed six
 * minutes before the next unwanted switch.
 */
describe('what a client said about itself', () => {
  test('the three words the election judges it by', () => {
    expect(describeDeclaration({ visible: true, fresh: true })).toBe('visible, opened');
    expect(describeDeclaration({ visible: true, fresh: false })).toBe('visible, reconnected');
    expect(describeDeclaration({ visible: false })).toBe('hidden, reconnected');
  });

  /** The one that explains a screenshot agent sitting in the list and never
   *  winning anything. */
  test('a driven browser says so', () => {
    expect(describeDeclaration({ visible: true, fresh: true, automated: true })).toBe(
      'visible, opened, automated',
    );
  });

  /** A client too old to send `fresh` reads as a reconnect, which is what the
   *  election already treats it as. */
  test('an old client reads as a reconnect', () => {
    expect(describeDeclaration({ visible: true })).toBe('visible, reconnected');
  });
});

/**
 * The glasses subscribe because the election sent them somewhere, so their
 * subscriptions are its own output. Until now one still wrote `focusAt` and
 * logged a claim that never took place - the only thing between that write and
 * a self-sustaining loop was `pickClientFocus` reading a different pair of
 * fields. Measured 2026-08-14: every real claim in the log was shadowed a second
 * later by `[focus] undeclared claims ... (no device id)`, the glasses arriving
 * where they had just been sent.
 */
describe('a glasses subscription is not a claim', () => {
  test('a follow writes nothing at all', () => {
    const data = { isGlasses: true, focusSessionId: undefined, focusAt: undefined };
    applySubscribeFocus(data, { sessionId: 'w4Y' }, 999);
    expect(data.focusSessionId).toBeUndefined();
    expect(data.focusAt).toBeUndefined();
  });

  /** The wearer's own act arrives on `glasses-focus`, and still wins. */
  test('the ring still claims', () => {
    const glasses = client({
      isGlasses: true,
      glassesFocusSessionId: 'w66',
      glassesFocusAt: 200,
    } as Partial<MuxData>);
    applySubscribeFocus(glasses, { sessionId: 'w4Y' }, 999);
    expect(pickClientFocus([glasses], NOW)?.sessionId).toBe('w66');
  });

  test('an ordinary client is unaffected', () => {
    const data: { focusSessionId?: string; focusAt?: number } = {
      focusSessionId: undefined,
      focusAt: undefined,
    };
    applySubscribeFocus(data, { sessionId: 'w4Y' }, 999);
    expect(data).toEqual({ focusSessionId: 'w4Y', focusAt: 999 });
  });
});
