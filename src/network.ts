/**
 * Network-state machine: ONLINE ⇄ OFFLINE, driven by a periodic
 * probe (not `navigator.onLine` alone — unreliable) plus a manual "Airgap
 * mode" override that pins OFFLINE regardless of probe results, for
 * facilities where even probing is prohibited.
 *
 * Probe target is same-origin ("/", our own deployed app), not a
 * third-party endpoint — a network-restricted defense facility (the
 * scenario this whole app is built for) may have reachability to our
 * deployed origin and the online-mode services (OpenRouter/Deepgram/Sheets)
 * without general internet access, so probing a third party would give a
 * false negative. The probe uses HEAD specifically because Workbox's
 * generated Service Worker only intercepts GET requests for its caching
 * strategies — HEAD always reaches the real network (or genuinely fails
 * offline), so the aggressive PWA precache (vite.config.ts) can't mask a
 * real outage by serving a cached response.
 */
import type { NetworkMode } from "./schema.js";

const PROBE_INTERVAL_MS = 30_000;
const PROBE_URL = "/";
const PROBE_TIMEOUT_MS = 4000;

export type NetworkModeListener = (mode: NetworkMode) => void;

export class NetworkStateMachine {
  private mode: NetworkMode = navigator.onLine ? "online" : "offline";
  private airgapOverride = false;
  private listeners = new Set<NetworkModeListener>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  private readonly handleBrowserOnline = () => void this.probeNow();
  private readonly handleBrowserOffline = () => this.setMode("offline");

  start(): void {
    window.addEventListener("online", this.handleBrowserOnline);
    window.addEventListener("offline", this.handleBrowserOffline);
    this.probeTimer = setInterval(() => void this.probeNow(), PROBE_INTERVAL_MS);
    void this.probeNow();
  }

  stop(): void {
    window.removeEventListener("online", this.handleBrowserOnline);
    window.removeEventListener("offline", this.handleBrowserOffline);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** "Airgap mode" toggle. */
  setAirgapOverride(enabled: boolean): void {
    this.airgapOverride = enabled;
    if (enabled) {
      this.setMode("offline");
    } else {
      void this.probeNow();
    }
  }

  isAirgapOverride(): boolean {
    return this.airgapOverride;
  }

  getMode(): NetworkMode {
    return this.mode;
  }

  /** Calls `listener` immediately with the current mode, then on every
   * change. Returns an unsubscribe function. */
  subscribe(listener: NetworkModeListener): () => void {
    this.listeners.add(listener);
    listener(this.mode);
    return () => this.listeners.delete(listener);
  }

  private async probeNow(): Promise<void> {
    if (this.airgapOverride) {
      this.setMode("offline");
      return;
    }
    if (!navigator.onLine) {
      this.setMode("offline");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(PROBE_URL, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      this.setMode("online");
    } catch {
      this.setMode("offline");
    } finally {
      clearTimeout(timeout);
    }
  }

  private setMode(mode: NetworkMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const listener of this.listeners) listener(mode);
  }
}

/** Singleton shared across systems/modules (index.ts starts it; session.ts,
 * hud wiring, and the welcome panel's Airgap toggle all read/observe it). */
export const networkStateMachine = new NetworkStateMachine();
