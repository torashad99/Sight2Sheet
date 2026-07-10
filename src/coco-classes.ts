/**
 * The 80 COCO detection classes EfficientDet-Lite0 was trained on.
 * Used by the offline rule-based config fallback (config-store.ts) to check
 * whether an inspector's free-text task description literally names a
 * detectable class, and by cv-pipeline.ts to validate `target_classes`
 * entries in a cached config before wiring them into the detector.
 *
 * None of "fire extinguisher", "pressure gauge", or "hard hat" are COCO
 * classes. The demo leans on proxy
 * objects (bottle, fire hydrant, clock, ...) + OCR for asset IDs.
 */
export const COCO_CLASSES: readonly string[] = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
] as const;

/**
 * Domain-term → COCO proxy-class map for the offline rule-fallback mapper.
 * Deliberately crude — the supported path is pre-mission LLM
 * config; this only keeps the loop functional if a *new* task is defined
 * while already in the gap.
 */
export const DOMAIN_PROXY_MAP: ReadonlyArray<{
  pattern: RegExp;
  classes: string[];
}> = [
  { pattern: /extinguisher/i, classes: ["fire hydrant", "bottle"] },
  { pattern: /gauge|pressure|dial|meter/i, classes: ["clock"] },
  { pattern: /hard ?hat|helmet/i, classes: ["frisbee"] },
  { pattern: /valve|pipe|tank/i, classes: ["bottle"] },
  { pattern: /sign|placard|label/i, classes: ["stop sign"] },
  { pattern: /panel|switch|breaker/i, classes: ["remote", "keyboard"] },
];

/** Regexes used to pull a candidate ID pattern out of a free-text task
 * description, e.g. "...labeled EXT-0417..." → "^EXT-\\d{3,5}$". */
const ID_PATTERN_HINTS: ReadonlyArray<{ probe: RegExp; hint: string }> = [
  { probe: /\bEXT-\d+\b/i, hint: "^EXT-\\d{3,5}$" },
  { probe: /\b[A-Z]{2,5}-\d{2,6}\b/, hint: "^[A-Z]{2,5}-\\d{2,6}$" },
];

export function guessRegexHint(taskDescription: string): string | undefined {
  for (const { probe, hint } of ID_PATTERN_HINTS) {
    if (probe.test(taskDescription)) return hint;
  }
  return undefined;
}
