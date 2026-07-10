/**
 * CSV + manifest export.
 * This is the guaranteed offline output the whole MVP claim rests on —
 * everything here is a client-side Blob download, zero network.
 */
import { listBySession, getFrameBlob } from "./queue.js";
import type {
  CVConfig,
  FindingRecord,
  NetworkMode,
  SessionManifest,
} from "../schema.js";

const APP_VERSION = "0.1.0";

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * A CV Config's `log_schema.columns` is inspector/LLM-authored
 * free text (e.g. "gauge_status", "asset_id") — there's no fixed schema to
 * pull those from. This maps the columns the finding record *does*
 * structurally capture, plus reasonable aliases for common column names;
 * anything unrecognized exports as an empty cell rather than failing.
 */
export function findingFieldMap(finding: FindingRecord): Record<string, string> {
  return {
    timestamp: finding.t_wall,
    t_wall: finding.t_wall,
    t_session_ms: String(finding.t_session_ms),
    asset_id: finding.ocr_text ?? "",
    ocr_text: finding.ocr_text ?? "",
    detection_class: finding.detection?.class ?? "",
    class: finding.detection?.class ?? "",
    confidence: finding.detection ? finding.detection.score.toFixed(3) : "",
    score: finding.detection ? finding.detection.score.toFixed(3) : "",
    // No dedicated structured field for a domain judgment like "gauge in
    // the green zone" — best-effort from the inspector's spoken note.
    gauge_status: finding.voice_note ?? "",
    status: finding.voice_note ?? "",
    notes: finding.voice_note ?? "",
    voice_note: finding.voice_note ?? "",
    pose_x: finding.pose.x.toFixed(3),
    pose_y: finding.pose.y.toFixed(3),
    pose_z: finding.pose.z.toFixed(3),
    frame_ref: finding.frame_ref ?? "",
  };
}

/** Raw (unescaped) column values for a finding — shared by CSV export here
 * and by log/sync.ts's Sheets append, so both destinations agree on shape. */
export function mapFindingToColumns(
  finding: FindingRecord,
  columns: string[],
): string[] {
  const fields = findingFieldMap(finding);
  return columns.map((col) => fields[col] ?? "");
}

function findingToRow(finding: FindingRecord, columns: string[]): string {
  return mapFindingToColumns(finding, columns).map(csvEscape).join(",");
}

export async function buildSessionCsv(
  sessionId: string,
  config: CVConfig,
): Promise<string> {
  const findings = await listBySession(sessionId);
  const columns = config.log_schema.columns;
  const header = columns.map(csvEscape).join(",");
  const rows = findings.map((f) => findingToRow(f, columns));
  return [header, ...rows].join("\r\n") + "\r\n";
}

export interface BuildManifestParams {
  sessionId: string;
  sessionCreatedAt: string;
  config: CVConfig;
  networkMode: NetworkMode;
}

export async function buildSessionManifest(
  params: BuildManifestParams,
): Promise<SessionManifest> {
  const findings = await listBySession(params.sessionId);
  return {
    session_id: params.sessionId,
    config: params.config,
    created_at: params.sessionCreatedAt,
    exported_at: new Date().toISOString(),
    finding_count: findings.length,
    app_version: APP_VERSION,
    network_mode_at_export: params.networkMode,
  };
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export interface ExportSessionResult {
  csv: string;
  manifest: SessionManifest;
}

/** The EXPORT state / step 6 "export" voice command: writes
 * `session-<id>.csv` + `session-<id>.manifest.json` as browser downloads. */
export async function exportSession(
  params: BuildManifestParams,
): Promise<ExportSessionResult> {
  const [csv, manifest] = await Promise.all([
    buildSessionCsv(params.sessionId, params.config),
    buildSessionManifest(params),
  ]);

  downloadBlob(
    `session-${params.sessionId}.csv`,
    new Blob([csv], { type: "text/csv" }),
  );
  downloadBlob(
    `session-${params.sessionId}.manifest.json`,
    new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    }),
  );

  return { csv, manifest };
}

// ---------------------------------------------------------------------------
// Frame capture export — a minimal hand-rolled STORE-only (no
// compression) ZIP writer, avoiding a zip-library dependency for what's an
// explicitly secondary/optional export path.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; dosDate: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, dosDate };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZipStore(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  const { time, dosDate } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length

    const localHeader = new Uint8Array(local.buffer);
    chunks.push(localHeader, nameBytes, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number
    central.setUint16(36, 0, true); // internal attrs
    central.setUint32(38, 0, true); // external attrs
    central.setUint32(42, offset, true); // local header offset
    centralChunks.push(new Uint8Array(central.buffer), nameBytes);

    offset += localHeader.length + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  // Cast needed under TS's newer generic-typed-array lib defs: bare
  // `Uint8Array` widens to `Uint8Array<ArrayBufferLike>`, which doesn't
  // structurally match `BlobPart`'s `ArrayBufferView<ArrayBuffer>` — all of
  // these are in fact ArrayBuffer-backed (never SharedArrayBuffer).
  return new Blob(
    [...chunks, ...centralChunks, new Uint8Array(eocd.buffer)] as BlobPart[],
    { type: "application/zip" },
  );
}

/** Explicit-request-only export of captured frames as a zip. Returns null (and downloads nothing) if the session has no frames. */
export async function exportSessionFrames(
  sessionId: string,
): Promise<Blob | null> {
  const findings = await listBySession(sessionId);
  const withFrames = findings.filter((f) => f.frame_ref !== null);
  if (withFrames.length === 0) return null;

  const entries: ZipEntry[] = [];
  for (const finding of withFrames) {
    const blob = await getFrameBlob(finding.frame_ref!);
    if (!blob) continue;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    entries.push({ name: `${finding.id}.jpg`, data: buffer });
  }
  if (entries.length === 0) return null;

  const zip = buildZipStore(entries);
  downloadBlob(`session-${sessionId}-frames.zip`, zip);
  return zip;
}
