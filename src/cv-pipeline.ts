/**
 * Config-driven MediaPipe/Tesseract orchestrator.
 *
 * MediaPipe Tasks Vision has no JS OCR task —
 * "TextDetector" doesn't exist for web. OCR here is Tesseract.js (self-hosted
 * WASM, fully offline) instead; the CV Config's `pipelines[].type: "ocr"`
 * shape.
 *
 * Object detection runs in a dedicated Web Worker (detect-worker.ts):
 * MediaPipe inference is a synchronous wasm call, and running it on the main
 * thread stuttered the XR render loop on-device. The main-thread side here
 * is just RPC — transfer an ImageBitmap in, get DetectionInfo[] back.
 *
 * "Single pipeline at a time": object detection and OCR are
 * exposed as separate entry points rather than one combined per-frame call,
 * so the caller (session.ts) runs detection every throttled pass but only
 * runs the much heavier OCR pass against a specific candidate detection
 * (e.g. once when it becomes the pending confirmation), not continuously.
 */
import { createWorker, PSM, type Worker as TesseractWorker } from "tesseract.js";
import type {
  DetectWorkerRequest,
  DetectWorkerResponse,
} from "./detect-worker.js";
import {
  isObjectDetectionPipeline,
  type CVConfig,
  type DetectionInfo,
  type OcrPipeline,
} from "./schema.js";

const MODELS_BASE = "/models";

/** Bail out of a detection pass if the worker never answers (wedged wasm). */
const DETECT_TIMEOUT_MS = 10_000;

// Self-hosted paths. Defaults to OEM.LSTM_ONLY, which
// matches the simd-lstm-only core variant fetched by tools/fetch-assets.mjs.
const OCR_WORKER_OPTIONS = {
  corePath: `${window.location.origin}/wasm/tesseract`,
  workerPath: `${window.location.origin}/wasm/tesseract/worker.min.js`,
  langPath: `${window.location.origin}/models/tessdata`,
  gzip: true,
};

let detectWorker: Worker | null = null;
let detectorReady = false;
let detectorLoading: Promise<boolean> | null = null;
let detectorConfigId: string | null = null;
let resolveDetectorReady: ((ok: boolean) => void) | null = null;
let nextDetectId = 1;
const pendingDetects = new Map<
  number,
  { resolve: (detections: DetectionInfo[]) => void; timeout: ReturnType<typeof setTimeout> }
>();

let ocrWorker: TesseractWorker | null = null;
let ocrWorkerLoading: Promise<TesseractWorker> | null = null;

function ensureDetectWorker(): Worker {
  if (detectWorker) return detectWorker;
  detectWorker = new Worker(new URL("./detect-worker.ts", import.meta.url), {
    type: "module",
  });
  detectWorker.onmessage = (event: MessageEvent<DetectWorkerResponse>) => {
    const msg = event.data;
    if (msg.type === "ready") {
      detectorReady = true;
      console.info("[cv] object detector ready (worker)");
      resolveDetectorReady?.(true);
      resolveDetectorReady = null;
    } else if (msg.type === "init-error") {
      console.error("[cv] object-detector init failed in worker:", msg.message);
      resolveDetectorReady?.(false);
      resolveDetectorReady = null;
    } else if (msg.type === "result") {
      const pending = pendingDetects.get(msg.id);
      if (!pending) return;
      pendingDetects.delete(msg.id);
      clearTimeout(pending.timeout);
      // Highest-confidence first — session.ts treats index 0 as "the"
      // pending candidate for DETECT_PENDING.
      pending.resolve(msg.detections.sort((a, b) => b.score - a.score));
    }
  };
  return detectWorker;
}

/**
 * Warms up the ObjectDetector (in its worker) for the given config. Call
 * once at CONFIG_LOAD/FIELDWORK start — this is the expensive one-time
 * wasm+model init, not something to redo per pass. Resolves true when the
 * detector is ready, false when the config has no detection pipeline or
 * init failed (detection passes then no-op).
 */
export async function preloadObjectDetector(
  config: CVConfig,
): Promise<boolean> {
  const pipeline = config.pipelines.find(isObjectDetectionPipeline);
  if (!pipeline) {
    disposeObjectDetector();
    return false;
  }
  if (detectorConfigId === config.config_id && (detectorReady || detectorLoading)) {
    return detectorLoading ?? true;
  }

  const worker = ensureDetectWorker();
  detectorConfigId = config.config_id;
  detectorReady = false;
  // A re-init (config change) may land while a previous init is still
  // pending — settle the old waiter so its await doesn't hang forever.
  resolveDetectorReady?.(false);
  detectorLoading = new Promise<boolean>((resolve) => {
    resolveDetectorReady = resolve;
  });

  const initMsg: DetectWorkerRequest = {
    type: "init",
    // Absolute URLs — relative paths would resolve against the worker
    // script's URL, not the app origin.
    wasmBase: `${window.location.origin}/wasm/mediapipe`,
    modelUrl: `${window.location.origin}${MODELS_BASE}/${pipeline.model}.tflite`,
    scoreThreshold: pipeline.score_threshold,
    targetClasses: pipeline.target_classes,
  };
  worker.postMessage(initMsg);
  return detectorLoading;
}

export function isDetectorReady(): boolean {
  return detectorReady;
}

/**
 * Runs one detection pass in the worker. Takes ownership of `bitmap`
 * (transfers it; the worker closes it). Resolves [] rather than rejecting
 * on any failure path so callers can't leak an unhandled rejection from a
 * dropped pass.
 */
export function detectObjectsAsync(
  bitmap: ImageBitmap,
): Promise<DetectionInfo[]> {
  if (!detectWorker || !detectorReady) {
    bitmap.close();
    return Promise.resolve([]);
  }
  const worker = detectWorker;
  const id = nextDetectId++;
  return new Promise<DetectionInfo[]>((resolve) => {
    const timeout = setTimeout(() => {
      pendingDetects.delete(id);
      console.warn("[cv] detection pass timed out after", DETECT_TIMEOUT_MS, "ms");
      resolve([]);
    }, DETECT_TIMEOUT_MS);
    pendingDetects.set(id, { resolve, timeout });
    const msg: DetectWorkerRequest = { type: "detect", id, bitmap };
    worker.postMessage(msg, [bitmap]);
  });
}

function disposeObjectDetector(): void {
  for (const { resolve, timeout } of pendingDetects.values()) {
    clearTimeout(timeout);
    resolve([]);
  }
  pendingDetects.clear();
  resolveDetectorReady?.(false);
  resolveDetectorReady = null;
  detectWorker?.terminate();
  detectWorker = null;
  detectorReady = false;
  detectorLoading = null;
  detectorConfigId = null;
}

/**
 * Warms up the Tesseract worker. Lazy — call after CV (object detector) has
 * already warmed up, so two wasm runtimes don't fight for memory during boot.
 */
export async function preloadOcrWorker(): Promise<TesseractWorker> {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerLoading) {
    ocrWorkerLoading = createWorker("eng", undefined, OCR_WORKER_OPTIONS).then(
      async (w) => {
        // SPARSE_TEXT: find text anywhere in the crop instead of assuming a
        // clean document page — a tag is a small text island in a scene
        // crop, and the default page segmentation often misses it entirely
        // at off-axis viewing angles.
        await w.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        });
        ocrWorker = w;
        return w;
      },
    );
  }
  return ocrWorkerLoading;
}

// Asset-tag charset (uppercase + digits + dash). Constraining Tesseract's
// alphabet sharply reduces misreads on foreshortened/perspective-distorted
// text — the main reason tags only resolved head-on. Applied only for
// pipelines with a regex_hint (i.e. structured tags, not free-form labels).
const TAG_CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
let appliedWhitelist: string | null = null;

async function applyOcrCharset(pipeline: OcrPipeline): Promise<void> {
  if (!ocrWorker) return;
  const wanted = pipeline.regex_hint ? TAG_CHAR_WHITELIST : "";
  if (wanted === appliedWhitelist) return;
  await ocrWorker.setParameters({ tessedit_char_whitelist: wanted });
  appliedWhitelist = wanted;
}

export function isOcrWorkerReady(): boolean {
  return ocrWorker !== null;
}

/**
 * Runs OCR against the region described by the OCR pipeline config, cropped
 * around `detectionBbox` when `region === "near_detection"`. Returns the
 * regex-matched substring (if `regex_hint` is set) or the trimmed raw text.
 */
export async function runOcr(
  pipeline: OcrPipeline,
  frameCanvas: HTMLCanvasElement,
  detectionBbox: DetectionInfo["bbox"] | null,
): Promise<string | null> {
  if (!ocrWorker) return null;
  await applyOcrCharset(pipeline);

  let source: HTMLCanvasElement = frameCanvas;
  if (pipeline.region === "near_detection" && detectionBbox) {
    source = cropRegion(frameCanvas, detectionBbox);
  }

  const { data } = await ocrWorker.recognize(source);
  return matchAgainstHint(data.text, pipeline.regex_hint);
}

function cropRegion(
  source: HTMLCanvasElement,
  bbox: DetectionInfo["bbox"],
  padding = 0.35,
): HTMLCanvasElement {
  const [x, y, w, h] = bbox;
  const padX = w * padding;
  const padY = h * padding;
  const cropX = Math.max(0, x - padX);
  const cropY = Math.max(0, y - padY);
  const cropW = Math.min(source.width - cropX, w + padX * 2);
  const cropH = Math.min(source.height - cropY, h + padY * 2);

  // Upscale small crops: Tesseract wants glyphs ~30px+ tall, and a tag seen
  // from a distance or at an angle lands well under that. 2.5x cap keeps the
  // canvas bounded.
  const scale = Math.min(2.5, Math.max(1, 600 / Math.max(1, cropW)));

  // OCR runs at most ~once per retry interval (not per frame), so a fresh
  // small canvas here is an acceptable allocation, unlike the render hot path.
  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(cropW * scale));
  crop.height = Math.max(1, Math.round(cropH * scale));
  const ctx = crop.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    source,
    cropX,
    cropY,
    cropW,
    cropH,
    0,
    0,
    crop.width,
    crop.height,
  );
  return crop;
}

function matchAgainstHint(text: string, hint?: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!hint) return trimmed;
  try {
    // "m" flag: hints like ^EXT-\d{3,5}$ should match a tag on its own LINE,
    // not require the entire OCR output to be the tag — real crops always
    // contain extra lines/noise around the label.
    const lineMatch = trimmed.match(new RegExp(hint, "m"));
    if (lineMatch) return lineMatch[0];
    // Fallback: strip anchors and search anywhere. Catches "EXT-0042" glued
    // to OCR junk on the same line ("• EXT-0042 ."), which the anchored form
    // misses. Matters doubly because configs are cached in IndexedDB — an
    // over-strict hint on a deployed device can't be fixed by reseeding.
    const unanchored = hint.replace(/^\^/, "").replace(/\$$/, "");
    if (unanchored !== hint) {
      const anyMatch = trimmed.match(new RegExp(unanchored));
      if (anyMatch) return anyMatch[0];
    }
    return null;
  } catch {
    // Malformed regex_hint (e.g. from a hand-authored config) — degrade to
    // raw text rather than dropping the finding entirely.
    return trimmed;
  }
}

/** Frees wasm/GPU resources. Call on world visibility Hidden or session end. */
export function disposeCVPipeline(): void {
  disposeObjectDetector();
  if (ocrWorker) {
    void ocrWorker.terminate();
    ocrWorker = null;
  }
  ocrWorkerLoading = null;
  appliedWhitelist = null;
}
