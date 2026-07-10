/**
 * Post-mission Google Sheets sync. ONLINE-only; stubbed behind
 * VITE_GSHEETS_CLIENT_ID + VITE_GSHEETS_SPREADSHEET_ID per the user's
 * choice — without both, `syncQueue` is a no-op and CSV export
 * (log/exporter.ts) remains the guaranteed output regardless.
 *
 * Uses Google Identity Services' OAuth token-client popup. If the in-headset
 * consent popup proves unusable on-device, the companion-page approach
 * (same origin, shared token) is the documented next step; the queue stays
 * exportable via CSV either way.
 *
 * Known limitation: Sheets `values.append` isn't idempotent. A row is only
 * marked `synced` after a confirmed successful response, but if a response
 * is lost after the server actually wrote it (rare, but possible over a
 * flaky reconnect), a retry can duplicate that row. Each finding's `id`
 * (visible in the exported manifest/CSV) is the de-dup key if that ever
 * needs cleaning up manually.
 */
import { getConfigById } from "../config-store.js";
import type { FindingRecord } from "../schema.js";
import { mapFindingToColumns } from "./exporter.js";
import { listUnsynced, markSynced } from "./queue.js";

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEET_RANGE = "Sheet1!A1"; // adjust if the target tab isn't "Sheet1"
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const DEFAULT_SYNC_COLUMNS = [
  "timestamp",
  "asset_id",
  "detection_class",
  "confidence",
  "notes",
  "pose_x",
  "pose_y",
  "pose_z",
  "frame_ref",
];

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface GoogleIdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: GoogleTokenResponse) => void;
      }): { requestAccessToken(): void };
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;
let gisLoadPromise: Promise<void> | null = null;

export function isSheetsConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_GSHEETS_CLIENT_ID &&
      import.meta.env.VITE_GSHEETS_SPREADSHEET_ID,
  );
}

function loadGisScript(): Promise<void> {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  await loadGisScript();
  const clientId = import.meta.env.VITE_GSHEETS_CLIENT_ID;
  if (!clientId) throw new Error("VITE_GSHEETS_CLIENT_ID is not set");

  return new Promise((resolve, reject) => {
    const google = window.google;
    if (!google?.accounts?.oauth2) {
      reject(new Error("Google Identity Services unavailable"));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SHEETS_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? "no access token returned"));
          return;
        }
        cachedToken = {
          value: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3000) * 1000 - 30_000,
        };
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}

async function appendRow(
  spreadsheetId: string,
  row: string[],
): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const token = await getAccessToken();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [row] }),
      });
      if (!res.ok) {
        throw new Error(`Sheets append HTTP ${res.status}: ${await res.text()}`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt),
        );
      }
    }
  }
  throw lastError;
}

async function buildRow(finding: FindingRecord): Promise<string[]> {
  const config = await getConfigById(finding.config_id);
  const columns = config?.log_schema.columns ?? DEFAULT_SYNC_COLUMNS;
  return mapFindingToColumns(finding, columns);
}

export interface SyncResult {
  synced: number;
  failed: number;
}

/** REVIEW → SYNC: drains the unsynced queue to the spreadsheet, marking
 * each row `synced` only after a confirmed successful append. Safe to call
 * repeatedly (e.g. every reconnect) — already-synced rows are skipped, and
 * a per-finding failure doesn't block the rest of the batch. */
export async function syncQueue(): Promise<SyncResult> {
  if (!isSheetsConfigured()) return { synced: 0, failed: 0 };

  const spreadsheetId = import.meta.env.VITE_GSHEETS_SPREADSHEET_ID!;
  const unsynced = await listUnsynced();
  let synced = 0;
  let failed = 0;

  for (const finding of unsynced) {
    try {
      const row = await buildRow(finding);
      await appendRow(spreadsheetId, row);
      await markSynced(finding.id);
      synced++;
    } catch (err) {
      console.error(`Failed to sync finding ${finding.id}:`, err);
      failed++;
    }
  }
  return { synced, failed };
}
