/**
 * Shared data contracts for Sight2Sheet
 * This is the single source of truth imported by config-store, cv-pipeline,
 * log/queue, log/exporter, log/sync, and session.
 */

// ---------------------------------------------------------------------------
// CV Config
// ---------------------------------------------------------------------------

/** Where a config came from: pre-mission LLM call, offline keyword fallback,
 * or hand-authored. */
export type ConfigOrigin = "llm" | "rule_fallback" | "manual";

export interface ObjectDetectionPipeline {
  type: "object_detection";
  model: string;
  target_classes: string[];
  score_threshold: number;
}

export interface OcrPipeline {
  type: "ocr";
  region: "near_detection" | "full_frame";
  /** Optional regex (as a string, compiled at use-time) findings must match
   * to be treated as a valid asset ID, e.g. "^EXT-\\d{3,5}$". */
  regex_hint?: string;
}

export type CVPipeline = ObjectDetectionPipeline | OcrPipeline;

export interface LogSchema {
  columns: string[];
}

export interface CVConfig {
  config_id: string;
  origin: ConfigOrigin;
  task_description: string;
  created_at: string; // ISO 8601
  pipelines: CVPipeline[];
  log_schema: LogSchema;
  /** Set only on the built-in seeded default (config-store.ts). Lets a new
   * app build refresh a stale cached seed in place — cached configs
   * otherwise outlive every code change to buildDefaultConfig(). */
  seed_version?: number;
}

export function isObjectDetectionPipeline(
  p: CVPipeline,
): p is ObjectDetectionPipeline {
  return p.type === "object_detection";
}

export function isOcrPipeline(p: CVPipeline): p is OcrPipeline {
  return p.type === "ocr";
}

/** Runtime shape check — cached configs are user/LLM data, don't trust them
 * blindly before wiring them into the CV pipeline. */
export function isCVConfig(value: unknown): value is CVConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.config_id === "string" &&
    (v.origin === "llm" || v.origin === "rule_fallback" || v.origin === "manual") &&
    typeof v.task_description === "string" &&
    typeof v.created_at === "string" &&
    Array.isArray(v.pipelines) &&
    v.pipelines.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as CVPipeline).type === "object_detection" ||
          (p as CVPipeline).type === "ocr"),
    ) &&
    typeof v.log_schema === "object" &&
    v.log_schema !== null &&
    Array.isArray((v.log_schema as LogSchema).columns)
  );
}

// ---------------------------------------------------------------------------
// Finding record
// ---------------------------------------------------------------------------

export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface DetectionInfo {
  class: string;
  score: number;
  /** [x, y, width, height] in source-frame pixels. */
  bbox: [number, number, number, number];
}

export interface FindingRecord {
  id: string;
  session_id: string;
  config_id: string;
  t_wall: string; // ISO 8601 wall-clock timestamp
  t_session_ms: number; // ms since session start
  pose: Pose;
  detection: DetectionInfo | null;
  ocr_text: string | null;
  voice_note: string | null;
  /** Key into the frame-blob store, or null if not captured. */
  frame_ref: string | null;
  synced: boolean;
}

// ---------------------------------------------------------------------------
// Export artifacts
// ---------------------------------------------------------------------------

export interface SessionManifest {
  session_id: string;
  config: CVConfig;
  created_at: string;
  exported_at: string;
  finding_count: number;
  app_version: string;
  network_mode_at_export: NetworkMode;
}

// ---------------------------------------------------------------------------
// Network state machine
// ---------------------------------------------------------------------------

export type NetworkMode = "online" | "offline";

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export const SessionState = {
  Idle: "IDLE",
  ConfigLoad: "CONFIG_LOAD",
  ConfigLlm: "CONFIG_LLM",
  ConfigFallback: "CONFIG_FALLBACK",
  Fieldwork: "FIELDWORK",
  DetectPending: "DETECT_PENDING",
  Export: "EXPORT",
  Review: "REVIEW",
  Sync: "SYNC",
  Done: "DONE",
} as const;

export type SessionStateType = (typeof SessionState)[keyof typeof SessionState];

// ---------------------------------------------------------------------------
// Voice / button grammar
// ---------------------------------------------------------------------------

export const VoiceCommand = {
  Confirm: "confirm",
  Skip: "skip",
  Note: "note",
  Pause: "pause",
  Resume: "resume",
  Export: "export",
  Status: "status",
} as const;

export type VoiceCommandType = (typeof VoiceCommand)[keyof typeof VoiceCommand];
