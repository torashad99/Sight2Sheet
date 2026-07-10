/**
 * Object-detection Web Worker. MediaPipe's ObjectDetector.detect() is a
 * synchronous wasm call — running it on the main thread blocked the XR
 * render loop's 11–14ms frame budget on every detection pass (the reported
 * on-device stutter). This worker owns the detector; the main thread
 * (cv-pipeline.ts) transfers one downscaled ImageBitmap per pass and the
 * render loop never waits on inference.
 *
 * Worker compatibility: MediaPipe's wasm loader calls importScripts, which
 * throws TypeError in a module worker — its loader catches that and falls
 * back to dynamic import() (verified in @mediapipe/tasks-vision 0.10.x
 * vision_bundle), so `{ type: "module" }` workers are supported.
 */
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import type { DetectionInfo } from "./schema.js";

export interface DetectWorkerInit {
  type: "init";
  /** Absolute URL base for the self-hosted MediaPipe wasm files. */
  wasmBase: string;
  /** Absolute URL of the .tflite detection model. */
  modelUrl: string;
  scoreThreshold: number;
  targetClasses: string[];
}

export interface DetectWorkerDetect {
  type: "detect";
  id: number;
  bitmap: ImageBitmap;
}

export type DetectWorkerRequest = DetectWorkerInit | DetectWorkerDetect;

export type DetectWorkerResponse =
  | { type: "ready" }
  | { type: "init-error"; message: string }
  | { type: "result"; id: number; detections: DetectionInfo[] };

// The project tsconfig uses the DOM lib (no webworker lib), so type the
// worker global structurally instead of via DedicatedWorkerGlobalScope.
const scope = self as unknown as {
  postMessage(message: DetectWorkerResponse): void;
  onmessage: ((event: MessageEvent<DetectWorkerRequest>) => void) | null;
};

let detector: ObjectDetector | null = null;

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    void handleInit(msg);
  } else if (msg.type === "detect") {
    handleDetect(msg);
  }
};

async function handleInit(msg: DetectWorkerInit): Promise<void> {
  try {
    detector?.close();
    detector = null;
    // useModule:true selects the ESM "_module_" wasm loader — required in a
    // module worker, where MediaPipe falls back to dynamic import() and the
    // classic loader's `var ModuleFactory` never reaches the worker global
    // ("Error: ModuleFactory not set").
    const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
    detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: msg.modelUrl,
        // GPU delegate runs on this worker's own GL context; the main
        // renderer no longer blocks either way. Flip to "CPU" if the Quest
        // browser shows GPU contention with the IWSDK/Three renderer
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      scoreThreshold: msg.scoreThreshold,
      categoryAllowlist: msg.targetClasses,
    });
    scope.postMessage({ type: "ready" });
  } catch (error) {
    scope.postMessage({ type: "init-error", message: String(error) });
  }
}

function handleDetect(msg: DetectWorkerDetect): void {
  const detections: DetectionInfo[] = [];
  try {
    if (detector) {
      const result = detector.detect(msg.bitmap);
      for (const d of result.detections) {
        const top = d.categories[0];
        if (!top || !d.boundingBox) continue;
        detections.push({
          class: top.categoryName,
          score: top.score,
          bbox: [
            d.boundingBox.originX,
            d.boundingBox.originY,
            d.boundingBox.width,
            d.boundingBox.height,
          ],
        });
      }
    }
  } finally {
    msg.bitmap.close();
    scope.postMessage({ type: "result", id: msg.id, detections });
  }
}
