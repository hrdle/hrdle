import { describe, expect, test } from 'bun:test';
import { applySubscribeFocus, pickClientFocus, type MuxData } from '../terminal-mux';

/**
 * The glasses follow the session open on the screen a person is looking at, so
 * that moving yourself moves them. Which screen that is has to be decided here,
 * because a wrong answer does not merely mislead - in a conversation the
 * glasses re-subscribe and clear what is on show, and a wearer mid-paragraph
 * loses it.
 */

function client(over: Partial<MuxData> = {}): MuxData {
  return {
    deviceType: 'desktop',
    visible: true,
    focusSessionId: 's1',
    focusAt: 1,
    ...over,
  } as MuxData;
}

describe('pickClientFocus', () => {
  test('the visible client that claimed most recently wins', () => {
    const focus = pickClientFocus([
      client({ focusSessionId: 'old', focusAt: 1 }),
      client({ focusSessionId: 'new', focusAt: 2, deviceType: 'mobile' }),
    ]);
    expect(focus).toEqual({ sessionId: 'new', deviceType: 'mobile', at: 2 });
  });

  test('a pocketed or undeclared client claims nothing', () => {
    expect(pickClientFocus([client({ visible: false })])).toBeUndefined();
    expect(pickClientFocus([client({ visible: undefined })])).toBeUndefined();
    expect(pickClientFocus([client({ deviceType: undefined })])).toBeUndefined();
  });

  /** Following its own focus would be a feedback loop. */
  test('the glasses do not claim the focus they follow', () => {
    expect(pickClientFocus([client({ isGlasses: true } as Partial<MuxData>)])).toBeUndefined();
  });

  /**
   * A browser being driven is not a screen anyone is looking at. This machine
   * runs several agents that open the web UI headlessly to take screenshots,
   * and each of them claimed the focus: a wearer reading one conversation was
   * carried into a workspace they had never touched, three times in one
   * recording, with every gesture of their own somewhere else.
   */
  test('a driven browser claims nothing', () => {
    expect(pickClientFocus([client({ automated: true })])).toBeUndefined();
  });

  test('and does not outbid a real one by being newer', () => {
    const focus = pickClientFocus([
      client({ focusSessionId: 'phone', focusAt: 1, deviceType: 'mobile' }),
      client({ focusSessionId: 'robot', focusAt: 99, automated: true }),
    ]);
    expect(focus?.sessionId).toBe('phone');
  });

  /**
   * A desktop someone is sitting at is still a person. Only automation is
   * excluded - the device type says where you are, not whether you are there.
   */
  test('a desktop is followed like any other screen', () => {
    expect(pickClientFocus([client({ deviceType: 'desktop' })])?.deviceType).toBe('desktop');
  });

  test('nobody connected means nobody to follow', () => {
    expect(pickClientFocus([])).toBeUndefined();
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
    expect(pickClientFocus([client(tablet), client(phone)])?.sessionId).toBe('w66');
  });
});
