/**
 * Offline findings queue.
 * IndexedDB is the guaranteed-durable store the whole airgap claim rests on —
 * every write here must succeed with zero network.
 */
import { getDB } from "../db.js";
import type { DetectionInfo, FindingRecord, Pose } from "../schema.js";

/**cap frame capture to bound IndexedDB growth. */
const MAX_FRAMES_PER_SESSION = 50;
const MAX_FRAME_BYTES = 200 * 1024; // 200 KB JPEG
const FRAME_JPEG_QUALITY = 0.6;

export interface EnqueueFindingInput {
  sessionId: string;
  configId: string;
  /** `performance.now()` captured at session start, for t_session_ms. */
  sessionStartMs: number;
  pose: Pose;
  detection: DetectionInfo | null;
  ocrText: string | null;
  voiceNote: string | null;
  /** Full-resolution frame canvas to (optionally) capture, subject to the
   * per-session cap above. Pass null/undefined to skip frame capture. */
  frameCanvas?: HTMLCanvasElement | null;
}

/**
 * Downscales/encodes a canvas to a JPEG Blob for frame capture, rejecting
 * (returning null) if it doesn't fit the 200KB cap even at reduced quality —
 * metadata-only logging is always preferred over blowing the storage budget.
 */
async function canvasToCappedJpeg(
  canvas: HTMLCanvasElement,
): Promise<Blob | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", FRAME_JPEG_QUALITY);
  });
  if (!blob || blob.size > MAX_FRAME_BYTES) return null;
  return blob;
}

export async function listBySession(
  sessionId: string,
): Promise<FindingRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex("findings", "by-session", sessionId);
}

export async function getSessionFindingsCount(
  sessionId: string,
): Promise<number> {
  return (await listBySession(sessionId)).length;
}

async function countSessionFrames(sessionId: string): Promise<number> {
  const findings = await listBySession(sessionId);
  return findings.filter((f) => f.frame_ref !== null).length;
}

/** The FIELDWORK "confirm" action: write one finding, capturing pose,
 * dual timestamps, detection/OCR, and (capacity-permitting) a frame. */
export async function enqueueFinding(
  input: EnqueueFindingInput,
): Promise<FindingRecord> {
  const db = await getDB();
  const id = crypto.randomUUID();

  let frameRef: string | null = null;
  if (input.frameCanvas) {
    const framesSoFar = await countSessionFrames(input.sessionId);
    if (framesSoFar < MAX_FRAMES_PER_SESSION) {
      const blob = await canvasToCappedJpeg(input.frameCanvas);
      if (blob) {
        frameRef = id;
        await db.put("frames", blob, frameRef);
      }
    }
  }

  const record: FindingRecord = {
    id,
    session_id: input.sessionId,
    config_id: input.configId,
    t_wall: new Date().toISOString(),
    t_session_ms: Math.round(performance.now() - input.sessionStartMs),
    pose: input.pose,
    detection: input.detection,
    ocr_text: input.ocrText,
    voice_note: input.voiceNote,
    frame_ref: frameRef,
    synced: false,
  };
  await db.put("findings", record);
  return record;
}

/** Total items awaiting sync across all sessions — what the HUD banner's
 * "N queued" and the REVIEW→SYNC drain both track. */
export async function getUnsyncedCount(): Promise<number> {
  const db = await getDB();
  const all = await db.getAll("findings");
  return all.filter((f) => !f.synced).length;
}

export async function listUnsynced(): Promise<FindingRecord[]> {
  const db = await getDB();
  const all = await db.getAll("findings");
  return all.filter((f) => !f.synced);
}

export async function markSynced(id: string): Promise<void> {
  const db = await getDB();
  const record = await db.get("findings", id);
  if (!record) return;
  record.synced = true;
  await db.put("findings", record);
}

export async function getFrameBlob(frameRef: string): Promise<Blob | null> {
  const db = await getDB();
  return (await db.get("frames", frameRef)) ?? null;
}

/**
 * Wipes the entire findings queue plus captured frames — synced AND unsynced
 * records (already-downloaded exports are files, unaffected). Demo/dev reset
 * for the welcome panel's "Clear Queue" button. Returns how many findings
 * were removed.
 */
export async function clearQueue(): Promise<number> {
  const db = await getDB();
  const count = await db.count("findings");
  const tx = db.transaction(["findings", "frames"], "readwrite");
  await Promise.all([
    tx.objectStore("findings").clear(),
    tx.objectStore("frames").clear(),
    tx.done,
  ]);
  return count;
}
