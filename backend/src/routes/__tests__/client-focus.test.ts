import { describe, expect, test } from 'bun:test';
import { pickClientFocus, type MuxData } from '../terminal-mux';

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
