import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Compass, compassHeading } from './compass';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('compass heading', () => {
  it.each(['granted', 'denied'])('remembers %s but checks browser permission in a new session', async (decision) => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const requestPermission = vi.fn().mockResolvedValue(decision);
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    const compass = new Compass(vi.fn());
    await Promise.all([compass.start(), compass.start()]);
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('unfog.compass-permission')).toBe(decision);
    const reopened = new Compass(vi.fn());
    await reopened.start();
    const calls = decision === 'granted' ? 2 : 1;
    expect(requestPermission).toHaveBeenCalledTimes(calls);
    await reopened.start();
    expect(requestPermission).toHaveBeenCalledTimes(calls);
    requestPermission.mockResolvedValue('granted');
    await reopened.start(true);
    expect(requestPermission).toHaveBeenCalledTimes(decision === 'denied' ? calls + 1 : calls);
    expect(localStorage.getItem('unfog.compass-permission')).toBe('granted');
  });

  it('reauthorizes a retained grant automatically on launch and foreground, without a location tap', async () => {
    vi.useFakeTimers();
    localStorage.setItem('unfog.compass-permission', 'granted');
    const win = Object.assign(new EventTarget(), {
      screen: { orientation: { angle: 0 } }, setTimeout, clearTimeout,
    });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    const onHeading = vi.fn();
    const compass = new Compass(onHeading);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    const event = Object.assign(new Event('deviceorientation'), {
      alpha: null, absolute: false, webkitCompassHeading: 75,
    });
    win.dispatchEvent(event);
    expect(onHeading).toHaveBeenLastCalledWith(75);
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(requestPermission).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    win.dispatchEvent(event);
    expect(onHeading).toHaveBeenLastCalledWith(75);
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'denied'])('allows a location tap to recover when automatic restoration returns %s', async (failure) => {
    localStorage.setItem('unfog.compass-permission', 'granted');
    vi.stubGlobal('window', Object.assign(new EventTarget(), { clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const requestPermission = vi.fn();
    if (failure === 'reject') requestPermission.mockRejectedValueOnce(new DOMException('Needs a gesture', 'NotAllowedError'));
    else requestPermission.mockResolvedValueOnce('denied');
    requestPermission.mockResolvedValue('granted');
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    const compass = new Compass(vi.fn());
    await Promise.resolve();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('unfog.compass-permission')).toBe('granted');
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it('does not repeat failed prompts or depend on writable storage', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    const requestPermission = vi.fn().mockRejectedValue(new Error('unavailable'));
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    const compass = new Compass(vi.fn());
    await compass.start();
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    requestPermission.mockResolvedValue('granted');
    await compass.start(true);
    await compass.start();
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it('uses iPhone compass readings even without GPS movement or absolute alpha', () => {
    expect(compassHeading({ alpha: null, absolute: false, webkitCompassHeading: 90 })).toBe(90);
    expect(compassHeading({ alpha: 100, absolute: false, webkitCompassHeading: 0 })).toBe(0);
  });

  it('converts absolute alpha and accounts for landscape orientation', () => {
    expect(compassHeading({ alpha: 90, absolute: true })).toBe(270);
    expect(compassHeading({ alpha: 90, absolute: true }, 90)).toBe(0);
    expect(compassHeading({ alpha: null, absolute: false, webkitCompassHeading: 20 }, -90)).toBe(290);
  });

  it('rejects relative, missing, invalid and uncalibrated sensor data', () => {
    expect(compassHeading({ alpha: 90, absolute: false })).toBeNull();
    expect(compassHeading({ alpha: null, absolute: true })).toBeNull();
    expect(compassHeading({ alpha: NaN, absolute: true })).toBeNull();
    expect(compassHeading({ alpha: null, absolute: false, webkitCompassHeading: 30, webkitCompassAccuracy: -1 })).toBeNull();
  });

  it('requests permission on the tap, emits stationary updates and clears stale headings', async () => {
    vi.useFakeTimers();
    const win = Object.assign(new EventTarget(), {
      screen: { orientation: { angle: 0 } }, setTimeout, clearTimeout,
    });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
    const onHeading = vi.fn();
    const compass = new Compass(onHeading);
    const started = compass.start();
    expect(requestPermission).toHaveBeenCalledWith(true);
    await started;
    const event = Object.assign(new Event('deviceorientation'), {
      alpha: null, absolute: false, webkitCompassHeading: 75,
    });
    win.dispatchEvent(event);
    expect(onHeading).toHaveBeenLastCalledWith(75);
    vi.advanceTimersByTime(5000);
    expect(onHeading).toHaveBeenLastCalledWith(null);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    onHeading.mockClear();
    win.dispatchEvent(event);
    expect(onHeading).not.toHaveBeenCalled();
  });
});
