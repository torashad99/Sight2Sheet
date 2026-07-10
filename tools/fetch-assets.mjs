#!/usr/bin/env node
/**
 * fetch-assets.mjs
 *
 * Populates public/wasm/ and public/models/ with everything the offline CV/STT
 * pipeline needs (MediaPipe ObjectDetector wasm + .task model, Tesseract.js OCR
 * core + eng traineddata, Vosk STT wasm model). This is a one-time, ONLINE,
 * pre-mission step — nothing here runs
 * during the offline gap. The downloaded files are self-hosted by the app (no
 * CDN reference at runtime) and are git-ignored; re-run this script to restore
 * them after a clean checkout.
 *
 * Usage: node tools/fetch-assets.mjs [--force]
 */

import { existsSync } from "node:fs";
import { mkdir, cp, rm, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const NODE_MODULES = path.join(ROOT, "node_modules");
const FORCE = process.argv.includes("--force");

const WASM_MEDIAPIPE_DIR = path.join(PUBLIC, "wasm", "mediapipe");
const WASM_TESSERACT_DIR = path.join(PUBLIC, "wasm", "tesseract");
const MODELS_DIR = path.join(PUBLIC, "models");
const TESSDATA_DIR = path.join(MODELS_DIR, "tessdata");
const VOSK_DIR = path.join(MODELS_DIR, "vosk");

// Note: this bucket publishes the raw .tflite model, not a .task bundle —
// MediaPipe's ObjectDetector.createFromOptions() accepts modelAssetPath
// pointing directly at a .tflite file.
const EFFICIENTDET_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";
const TESSDATA_ENG_TARBALL =
  "https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz";
const VOSK_MODEL_URL =
  "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip";
const VOSK_MODEL_NAME = "vosk-model-small-en-us-0.15";

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * The `tar`/`unzip` binaries used here are the MSYS/Git-Bash builds on
 * Windows. When Node spawns them directly (execFileSync, no shell), argv
 * backslashes get mangled by MSYS's path translation layer. Forward-slash
 * Windows paths (C:/foo/bar) are accepted by both MSYS tools and Windows
 * native tools, so normalize every path passed to them.
 */
function toToolPath(p) {
  return p.replace(/\\/g, "/");
}

async function downloadFile(url, destPath) {
  if (existsSync(destPath) && !FORCE) {
    console.log(`  skip (exists): ${path.relative(ROOT, destPath)}`);
    return;
  }
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await ensureDir(path.dirname(destPath));
  await pipeline(res.body, createWriteStream(destPath));
  console.log(`  wrote ${path.relative(ROOT, destPath)}`);
}

async function copyIfMissing(src, dest) {
  if (existsSync(dest) && !FORCE) return;
  await ensureDir(path.dirname(dest));
  await cp(src, dest);
}

// detect-worker.ts runs the detector in a module Web Worker and calls
// FilesetResolver.forVisionTasks(base, /* useModule */ true), which loads the
// ESM "_module_" loader pair (the classic loader's UMD `var ModuleFactory`
// never reaches the worker global under dynamic import() — "ModuleFactory
// not set"). The classic simd/nosimd pairs are kept as fallbacks for any
// main-thread use.
const MEDIAPIPE_WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

/** 1. MediaPipe Tasks Vision wasm (self-hosted, no CDN) */
async function fetchMediaPipeWasm() {
  console.log("\n[1/5] MediaPipe Tasks Vision wasm");
  const src = path.join(NODE_MODULES, "@mediapipe", "tasks-vision", "wasm");
  if (!existsSync(src)) {
    throw new Error(
      `MediaPipe wasm not found at ${src} — run "npm install" first`,
    );
  }
  await ensureDir(WASM_MEDIAPIPE_DIR);
  for (const file of MEDIAPIPE_WASM_FILES) {
    await copyIfMissing(
      path.join(src, file),
      path.join(WASM_MEDIAPIPE_DIR, file),
    );
  }
  console.log(
    `  copied ${MEDIAPIPE_WASM_FILES.length} files to public/wasm/mediapipe/`,
  );
}

/** 2. EfficientDet-Lite0 object detection model */
async function fetchObjectDetectorModel() {
  console.log("\n[2/5] EfficientDet-Lite0 (float16) object detection model");
  await downloadFile(
    EFFICIENTDET_URL,
    path.join(MODELS_DIR, "efficientdet_lite0.tflite"),
  );
}

// cv-pipeline.ts uses tesseract.js's default OEM (LSTM_ONLY), which only
// ever loads the "-lstm" core variants (simd or non-simd, chosen at runtime
// by wasm-feature-detect) — the plain (non-lstm) core is Tesseract's legacy
// engine and is never requested.
const TESSERACT_CORE_FILES = [
  "tesseract-core-lstm.wasm",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
];

/** 3. Tesseract.js OCR core (wasm) + worker script (self-hosted, no CDN) */
async function fetchTesseractCore() {
  console.log("\n[3/5] Tesseract.js OCR core + worker (self-hosted)");
  const coreSrc = path.join(NODE_MODULES, "tesseract.js-core");
  const workerSrc = path.join(
    NODE_MODULES,
    "tesseract.js",
    "dist",
    "worker.min.js",
  );
  if (!existsSync(coreSrc)) {
    throw new Error(`tesseract.js-core not found — run "npm install" first`);
  }
  await ensureDir(WASM_TESSERACT_DIR);
  const coreFiles = TESSERACT_CORE_FILES;
  for (const file of coreFiles) {
    await copyIfMissing(
      path.join(coreSrc, file),
      path.join(WASM_TESSERACT_DIR, file),
    );
  }
  await copyIfMissing(
    workerSrc,
    path.join(WASM_TESSERACT_DIR, "worker.min.js"),
  );
  console.log(
    `  copied ${coreFiles.length} core files + worker.min.js to public/wasm/tesseract/`,
  );
}

/** 4. English traineddata (gzipped, as tesseract.js expects by default) */
async function fetchTessdata() {
  console.log("\n[4/5] English traineddata (eng.traineddata.gz)");
  const dest = path.join(TESSDATA_DIR, "eng.traineddata.gz");
  if (existsSync(dest) && !FORCE) {
    console.log(`  skip (exists): ${path.relative(ROOT, dest)}`);
    return;
  }
  const tmpDir = path.join(ROOT, ".tmp-fetch-assets", "tessdata");
  await rm(tmpDir, { recursive: true, force: true });
  await ensureDir(tmpDir);
  const tarball = path.join(tmpDir, "eng.tgz");
  await downloadFile(TESSDATA_ENG_TARBALL, tarball);
  execFileSync(
    "tar",
    [
      "--force-local",
      "-xzf",
      toToolPath(tarball),
      "-C",
      toToolPath(tmpDir),
    ],
    { stdio: "inherit" },
  );
  // npm tarball extracts to <tmpDir>/package/4.0.0/eng.traineddata.gz
  // ("4.0.0" is the non-LSTM-only variant tesseract.js's getCore.js default
  // (lstmOnly=false) expects at `${langPath}/${lang}.traineddata.gz`)
  const extracted = path.join(
    tmpDir,
    "package",
    "4.0.0",
    "eng.traineddata.gz",
  );
  if (!existsSync(extracted)) {
    throw new Error(
      `Expected ${extracted} after extracting @tesseract.js-data/eng tarball`,
    );
  }
  await ensureDir(TESSDATA_DIR);
  await cp(extracted, dest);
  await rm(tmpDir, { recursive: true, force: true });
  console.log(`  wrote ${path.relative(ROOT, dest)}`);
}

/**
 * 5. Vosk small English STT model.
 * vosk-browser (Vosk.createModel) expects a gzipped TAR of a folder named
 * "model/..." (see node_modules/vosk-browser/README.md "Model format"), but
 * alphacephei distributes models as a plain .zip with a
 * "vosk-model-small-en-us-0.15/" top-level folder — so we download, unzip,
 * rename the top folder to "model", and re-pack as .tar.gz.
 */
async function fetchVoskModel() {
  console.log("\n[5/5] Vosk small English STT model (repacked as .tar.gz)");
  const dest = path.join(VOSK_DIR, `${VOSK_MODEL_NAME}.tar.gz`);
  if (existsSync(dest) && !FORCE) {
    console.log(`  skip (exists): ${path.relative(ROOT, dest)}`);
    return;
  }
  const tmpDir = path.join(ROOT, ".tmp-fetch-assets", "vosk");
  await rm(tmpDir, { recursive: true, force: true });
  await ensureDir(tmpDir);

  const zipPath = path.join(tmpDir, "model.zip");
  await downloadFile(VOSK_MODEL_URL, zipPath);

  console.log("  extracting zip...");
  execFileSync(
    "unzip",
    ["-q", toToolPath(zipPath), "-d", toToolPath(tmpDir)],
    { stdio: "inherit" },
  );

  const extractedDir = path.join(tmpDir, VOSK_MODEL_NAME);
  if (!existsSync(extractedDir)) {
    throw new Error(`Expected ${extractedDir} after unzipping vosk model`);
  }
  const modelDir = path.join(tmpDir, "model");
  await rename(extractedDir, modelDir);

  console.log("  repacking as tar.gz (model/ root)...");
  await ensureDir(VOSK_DIR);
  execFileSync(
    "tar",
    [
      "--force-local",
      "-czf",
      toToolPath(dest),
      "-C",
      toToolPath(tmpDir),
      "model",
    ],
    { stdio: "inherit" },
  );

  await rm(tmpDir, { recursive: true, force: true });
  console.log(`  wrote ${path.relative(ROOT, dest)}`);
}

async function main() {
  console.log(
    `Sight2Sheet asset fetch${FORCE ? " (--force, re-downloading everything)" : ""}`,
  );
  await ensureDir(PUBLIC);
  await fetchMediaPipeWasm();
  await fetchObjectDetectorModel();
  await fetchTesseractCore();
  await fetchTessdata();
  await fetchVoskModel();
  console.log(
    "\nDone. Run `npm run prefetch-check` to verify every asset resolves.",
  );
}

main().catch((err) => {
  console.error("\nfetch-assets failed:", err);
  process.exit(1);
});
