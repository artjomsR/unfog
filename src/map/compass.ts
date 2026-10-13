type CompassEvent = Pick<DeviceOrientationEvent, 'alpha' | 'absolute'> & {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

/** Relative orientation has no north reference and must never be used as a compass. */
export function compassHeading(event: CompassEvent, screenAngle = 0): number | null {
  let heading: number;
  if (typeof event.webkitCompassHeading === 'number') {
    if (event.webkitCompassAccuracy !== undefined && event.webkitCompassAccuracy < 0) return null;
    heading = event.webkitCompassHeading;
  } else if (event.absolute && event.alpha !== null) {
    heading = 360 - event.alpha;
  } else return null;
  if (!Number.isFinite(heading)) return null;
  return ((heading + screenAngle) % 360 + 360) % 360;
}

const PERMISSION_KEY = 'unfog.compass-permission';
type CompassPermission = 'granted' | 'denied' | null;

function savedPermission(): CompassPermission {
  try {
    const value = localStorage.getItem(PERMISSION_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

/** Compass updates affect only the marker, never GPS fixes or the recorded track. */
export class Compass {
  private enabled = false;
  private pending = false;
  private expiry = 0;
  private permission = savedPermission();
  private attempted = false;

  constructor(private readonly onHeading: (heading: number | null) => void) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.restore();
      else this.sync();
    });
    this.restore();
  }

  private restore(): void {
    if (this.permission !== 'granted' || document.visibilityState !== 'visible') return;
    this.enabled = false;
    this.attempted = false;
    this.sync();
    // Home Screen launches and foreground resumes must reauthorize too, not only taps.
    // Without a user gesture the API can reuse a grant, but rejects if a prompt is needed.
    // Avoid calling during a gesture so automatic restoration never opens a prompt.
    if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive) return;
    void this.authorize(true, true);
  }

  /** Must start synchronously from the locate tap for iOS's permission prompt. */
  async start(retry = false): Promise<void> {
    if (this.enabled) return;
    return this.authorize(retry, false);
  }

  private async authorize(retry: boolean, restoring: boolean): Promise<void> {
    if (this.pending || typeof DeviceOrientationEvent === 'undefined') return;
    if (!retry && (this.enabled || this.attempted || this.permission === 'denied')) return;
    // Like starting a new geolocation watch, ask the browser to authorize this session.
    // It can reuse its grant silently; localStorage cannot replace this API call.
    this.pending = true;
    if (!restoring) this.attempted = true;
    try {
      const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: (absolute?: boolean) => Promise<string>;
      };
      const result = orientation.requestPermission ? await orientation.requestPermission(true) : 'granted';
      // Failure to restore is not a new user decision. Keep the preference and let the
      // next explicit location tap request access if iOS discarded its session grant.
      if (restoring && result !== 'granted') return;
      this.permission = result === 'granted' ? 'granted' : 'denied';
      try {
        localStorage.setItem(PERMISSION_KEY, this.permission);
      } catch {
        // Keep the decision in memory when browser storage is unavailable.
      }
      this.enabled = this.permission === 'granted';
      this.sync();
    } catch {
      // GPS heading remains available if compass permission is denied or unsupported.
    } finally {
      this.pending = false;
    }
  }

  private readonly handle = (event: DeviceOrientationEvent): void => {
    const angle = window.screen.orientation?.angle ??
      (window as Window & { orientation?: number }).orientation ?? 0;
    const heading = compassHeading(event, angle);
    if (heading === null) return;
    this.enabled = true;
    this.onHeading(heading);
    window.clearTimeout(this.expiry);
    this.expiry = window.setTimeout(() => this.onHeading(null), 5000);
  };

  private sync(): void {
    window.removeEventListener('deviceorientation', this.handle);
    window.removeEventListener('deviceorientationabsolute', this.handle);
    window.clearTimeout(this.expiry);
    this.onHeading(null);
    if ((!this.enabled && this.permission !== 'granted') || document.visibilityState !== 'visible') return;
    window.addEventListener('deviceorientation', this.handle);
    window.addEventListener('deviceorientationabsolute', this.handle);
  }
}
