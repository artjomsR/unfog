/**
 * "Track my movement" (feedback-2): a once-a-year switch in Settings, not a map button.
 *
 * While the switch is on, a session runs whenever the app is open and on screen: it starts at
 * boot, the location watch pauses and resumes with the page's visibility (src/map/location.ts),
 * the wake lock is re-acquired on every return (src/record/session.ts) and every checkpoint
 * clears fog live. There is no Start/Stop and no summary sheet. Sessions roll over at local
 * midnight. After a relaunch, an unfinished journey is offered for resumption, preserving every
 * locally saved fix and leaving the unrecorded gap disconnected. The map shows a quiet status
 * pill; the Data screen lists the sessions.
 *
 * iOS only lets a web app record while it is open and the screen is on; the Settings note and
 * Help → "Always recording" say so instead of pretending otherwise.
 */
import { isSameLocalDay, loadUnfinishedSession, SESSION_KEY, saveUnfinishedSession, type SessionState, type RecorderEvents } from '../record/session';
import type { AppContext } from './context';
import { fmtInt } from './format';
import { icons } from './icons';
import { getSettings, readJSON, updateSettings, writeJSON } from './settings';
import { TRACKING_OFFER_KEY } from './store-keys';
import { confirmSheet, el, svg, toast } from './ui';

export interface TrackingController {
  /** The switch. */
  readonly enabled: boolean;
  /** A session is running right now. */
  readonly active: boolean;
  /**
   * Turn the switch. Call from a user gesture: the location prompt comes from it the first time.
   * Resolves to the resulting state (false when location was refused).
   */
  setEnabled(on: boolean): Promise<boolean>;
  /** Boot: offer to resume an interrupted journey, or save it and start a new one. */
  resume(): Promise<void>;
  /** First run: the "Track my movement?" card, once. */
  offerIfNeeded(): void;
  /** Save the running session as a track and start a fresh one (midnight; also a test hook). */
  rollover(): Promise<void>;
}

/** The recorder drops fixes worse than this (src/record/session.ts MAX_ACCURACY_M); the pill says so. */
const POOR_ACCURACY_M = 50;
const ROLLOVER_CHECK_MS = 60_000;

interface RouteRecovery {
  hasSavedJourney(): boolean;
  restoreJourney(): void;
  discardSavedJourney(): void;
}

export function createTracking(ctx: AppContext, hooks: RecorderEvents, routeRecovery?: RouteRecovery): TrackingController {
  const { shell, recorder, location } = ctx;

  // ---- status pill: the only trace of tracking on the map (top-left, under the search pill).
  const pillText = el('span', { class: 't' });
  const pill = el('button', { class: 'track-pill', type: 'button', hidden: true, onclick: () => ctx.openHelp('tracking') }, el('span', { class: 'dot' }), pillText);
  shell.bannerHost.appendChild(pill);

  let recoveryPending = false;
  let sessionDay = Date.now();
  let hadFix = false;
  let gpsNote = '';
  let wakeNote = '';
  let locError: 'denied' | 'unavailable' | null = null;

  function renderPill(): void {
    const on = getSettings().tracking;
    pill.hidden = !on;
    if (!on) return;
    let kind = 'on';
    let text = 'Tracking';
    if (recorder.status !== 'recording') {
      kind = 'paused';
      text = 'Tracking paused';
    } else if (locError === 'denied') {
      kind = 'paused';
      text = 'Tracking paused — location is off';
    } else if (locError === 'unavailable') {
      kind = 'paused';
      text = 'Tracking paused — no location';
    } else if (!hadFix) {
      kind = 'wait';
      text = 'Tracking · waiting for GPS';
    } else if (gpsNote) {
      kind = 'wait';
      text = gpsNote;
    } else if (wakeNote) {
      text = 'Tracking · keep the screen on';
    }
    pill.className = `track-pill ${kind}`;
    pillText.textContent = text;
  }

  hooks.onUpdate = () => renderPill();
  hooks.onWakeLock = (ok, reason) => {
    wakeNote = ok ? '' : reason ?? '';
    renderPill();
  };
  hooks.onFix = (fix) => {
    hadFix = true;
    locError = null;
    gpsNote = fix.accuracy > POOR_ACCURACY_M ? `Tracking · GPS ±${fmtInt(fix.accuracy)} m, waiting for better` : '';
    renderPill();
  };
  location.onError((kind) => {
    if (kind === 'denied' || kind === 'unavailable') {
      locError = kind;
      renderPill();
    }
  });
  // A "denied" drops every retained tag (src/map/location.ts); when the user comes back after
  // fixing it in iOS Settings, hold the watch again. Midnight may also have passed while hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (getSettings().tracking && recorder.status === 'recording' && !location.isRetained('record')) location.retain('record');
    void checkRollover();
  });

  async function startSession(resume?: SessionState): Promise<void> {
    if (recorder.status !== 'idle') return;
    hadFix = false;
    gpsNote = '';
    locError = null;
    sessionDay = Date.now();
    await recorder.start(resume);
    renderPill();
  }

  /** Stop = save: the final markTrack under the session's id, then the map/stats refresh. */
  async function endSession(): Promise<void> {
    if (recorder.status !== 'recording') return;
    const res = await recorder.stop();
    if (res && res.track.points.length >= 2) await ctx.dataChanged();
    renderPill();
  }

  async function checkRollover(): Promise<void> {
    const s = recorder.state;
    if (!s || recorder.status !== 'recording') return;
    if (isSameLocalDay(sessionDay, Date.now())) return;
    await api.rollover();
  }
  window.setInterval(() => void checkRollover(), ROLLOVER_CHECK_MS);

  const api: TrackingController = {
    get enabled() {
      return getSettings().tracking;
    },
    get active() {
      return recorder.status === 'recording';
    },
    async setEnabled(on) {
      if (recoveryPending) return getSettings().tracking;
      if (on) {
        if (getSettings().tracking && recorder.status === 'recording') return true;
        const ok = await ctx.requestLocation(); // the prompt, from this gesture; a toast when refused
        if (!ok) {
          updateSettings({ tracking: false });
          renderPill();
          return false;
        }
        updateSettings({ tracking: true });
        writeJSON(TRACKING_OFFER_KEY, Date.now());
        await startSession();
        toast('Tracking on — Unfog clears the fog as you move while it is open', { kind: 'success', duration: 4000 });
        return true;
      }
      updateSettings({ tracking: false });
      await endSession();
      toast('Tracking off');
      return false;
    },
    async resume() {
      // The real grid did not start and the app fell back to the in-page mock (src/app/engines.ts):
      // a "save" there vanishes on reload and a new session would be lost the same way. Leave the
      // unfinished session for a boot with the real grid and record nothing; the pill says paused.
      if (ctx.engines.gridMock && !ctx.engines.forceMock) {
        renderPill();
        return;
      }
      if (recoveryPending || recorder.status !== 'idle') return;
      const unfinished = loadUnfinishedSession();
      const canResumeRecording = unfinished && !unfinished.ended && unfinished.points.length && getSettings().tracking && location.supported;
      const hasRoute = routeRecovery?.hasSavedJourney() ?? false;
      if (canResumeRecording || hasRoute) {
        recoveryPending = true;
        renderPill();
        try {
          const resume = await confirmSheet({
            title: 'Resume your journey?',
            body: hasRoute ? 'Your navigation route is saved on this device. Resume to bring it back on the map. Any unrecorded GPS gap will stay disconnected.' : `Your GPS recording from ${new Date(unfinished!.startMs).toLocaleString()} was interrupted. Resume recording or save it and start a new journey. The unrecorded gap will stay disconnected.`,
            okLabel: 'Resume journey',
            cancelLabel: hasRoute ? 'End journey' : 'Save and start new',
            dismissible: false,
          });
          if (resume) {
            routeRecovery?.restoreJourney();
            const saved = await saveUnfinishedSession(ctx.engines.grid, !!canResumeRecording);
            if (saved) await ctx.dataChanged();
            if (getSettings().tracking && location.supported) await startSession(canResumeRecording ? unfinished! : undefined);
            return;
          }
          routeRecovery?.discardSavedJourney();
          // Persist the explicit decision before awaiting any database writes.
          if (unfinished) {
            unfinished.ended = true;
            writeJSON(SESSION_KEY, unfinished);
          }
        } finally {
          recoveryPending = false;
        }
      }
      const saved = await saveUnfinishedSession(ctx.engines.grid);
      if (saved) await ctx.dataChanged();
      if (getSettings().tracking && location.supported) await startSession();
      renderPill();
    },
    offerIfNeeded() {
      if (recoveryPending || getSettings().tracking || readJSON<number>(TRACKING_OFFER_KEY, 0) || !location.supported) return;
      const dismiss = () => {
        writeJSON(TRACKING_OFFER_KEY, Date.now());
        card.remove();
      };
      const card = el(
        'div',
        { class: 'offer-card', role: 'region', 'aria-label': 'Track my movement' },
        el('button', { class: 'icon-btn card-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, svg(icons.close)),
        el('div', { class: 'name', text: 'Track my movement?' }),
        el('div', { class: 'st', text: 'Unfog can clear the fog as you move, whenever it is open and on screen. Nothing leaves your phone. Change it any time in Help → Settings.' }),
        el(
          'div',
          { class: 'btn-row' },
          el('button', { class: 'btn ghost small', type: 'button', onclick: () => dismiss() }, 'Not now'),
          el('button', { class: 'btn primary small', type: 'button', onclick: async () => { dismiss(); await api.setEnabled(true); } }, 'Turn on'),
        ),
      );
      shell.sheetHost.appendChild(card);
    },
    async rollover() {
      if (recorder.status !== 'recording') return;
      await endSession();
      if (getSettings().tracking) await startSession();
      // The sync scheduler (src/sync/scheduler.ts) pulls the always-recording sources after a rollover.
      window.dispatchEvent(new CustomEvent('unfog:rollover'));
    },
  };
  return api;
}
