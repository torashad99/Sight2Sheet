# Sight2Sheet

A hands-free mixed-reality inspection assistant for any XR headset/glasses. The inspector describes
what to look for in natural language, an on-device computer-vision pipeline scans the
passthrough camera feed for it, and confirmed findings are logged with spatial and
temporal metadata — all without a network connection.

> "The inspector keeps judging; the glasses keep logging — even without a signal."

Built on the [Immersive Web SDK (IWSDK)](https://github.com/meta-quest/immersive-web-sdk) +
[Three.js.](https://github.com/mrdoob/three.js/)

## Why air-gapped

Cloud services (LLM config generation, Deepgram speech-to-text, Google Sheets sync) are
optional enhancements that only activate when a network is present. The entire fieldwork
loop — detection, voice/button confirm, logging, CSV export — runs with **zero network
connectivity**, which is the whole point for national-lab and defense-style
network-restricted environments.

## Features

- **Passthrough MR object detection** — MediaPipe Tasks Vision `ObjectDetector`
  (EfficientDet-Lite0) runs on-device in a Web Worker, drawing bounding-box overlays over
  the Quest 3 camera feed via the IWSDK `CameraSource`.
- **On-device OCR** — Tesseract.js reads asset ID tags/labels near a pending detection
  (e.g. `EXT-0417`), retrying against fresh frames until a tag is read.
- **Voice + button confirm** — a constrained Vosk WASM speech grammar
  (`confirm`, `skip`, `note <text>`, `pause`, `resume`, `export`, `status`) runs entirely
  on-device; the right Touch controller's A/B buttons mirror confirm/skip at all times as
  a fallback.
- **Natural-language CV configuration** — pre-mission, describe the inspection task in
  plain language and an LLM (via OpenRouter) generates a CV pipeline config + log schema,
  cached to IndexedDB for offline use. A keyword-based rule fallback covers defining a new
  task while already offline.
- **Offline-first logging** — every confirmed finding (timestamp, headset pose, detection
  class/confidence, OCR text, voice note, optional captured frame) is queued in
  IndexedDB, independent of connectivity.
- **Local export, always available** — "export" produces a downloadable CSV + JSON
  manifest (session metadata, config snapshot, provenance) directly from the Quest
  browser, with or without a network.
- **Automatic network-state machine** — a same-origin connectivity probe (not just
  `navigator.onLine`) switches between ONLINE/OFFLINE modes, swapping Deepgram ⇄ Vosk STT
  and pausing/resuming Google Sheets sync accordingly. A manual "Airgap mode" toggle pins
  the app to OFFLINE regardless of probe results.
- **Google Sheets sync** — once connectivity returns, queued findings drain to a
  configured spreadsheet via the Sheets API; synced rows are flagged so the queue never
  double-syncs.
- **Installable PWA** — the app shell, MediaPipe/Tesseract/Vosk WASM binaries, and models
  are precached via `vite-plugin-pwa`, so after one online visit the app cold-launches and
  runs the full detection loop in airplane mode.

## Requirements

- Node.js `>=20.19.0 <21` or `>=22.12.0 <23` or `>=24`
- A Meta Quest 3 (or the IWSDK emulator, see below) for the passthrough AR experience
- [Meta Spatial Editor](https://developers.meta.com/horizon/downloads/package/meta-spatial-editor-for-windows/)
  is **not** required — this project has no static scene composition, only runtime UI and
  CV/STT/logging systems

## Getting started

```bash
npm install
node tools/fetch-assets.mjs   # downloads MediaPipe/Tesseract/Vosk WASM + models into public/
npm run dev                   # starts the IWSDK dev server + emulator, opens the browser
```

`fetch-assets.mjs` is a one-time, online setup step that populates `public/wasm/` and
`public/models/` with everything the offline CV/STT pipeline needs (these directories are
git-ignored). Re-run it after a clean checkout, or with `--force` to redownload everything.
Run `npm run prefetch-check` afterward to verify every asset resolves correctly.

Once the dev server is running, enter the WebXR session from the browser prompt (or via
the IWER emulator) to start a fieldwork session in passthrough AR.

### Optional: online-mode features

Copy `.env.example` to `.env.local` and fill in what you have — the app runs the full
offline loop without any of these, they only unlock the pre-mission LLM config, the
Deepgram STT upgrade, and post-mission Sheets sync:

| Variable | Unlocks |
| --- | --- |
| `VITE_OPENROUTER_API_KEY` | Natural-language → CV config generation (`src/llm-config.ts`) |
| `VITE_DEEPGRAM_API_KEY` | Higher-accuracy online speech-to-text (`src/stt/deepgram-stt.ts`) |
| `VITE_GSHEETS_CLIENT_ID` / `VITE_GSHEETS_SPREADSHEET_ID` | Post-mission Google Sheets sync (`src/log/sync.ts`) |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the IWSDK-managed dev server + emulator, open the browser |
| `npm run dev:runtime` | Start the raw Vite dev server without the IWSDK CLI wrapper |
| `npm run dev:down` | Stop the IWSDK-managed dev server |
| `npm run dev:status` | Check whether a dev server is already running |
| `npm run build` | Production build to `dist/` (PWA precache included) |
| `npm run preview` | Preview the production build locally |
| `npm run fetch-assets` | Download/refresh WASM + model assets into `public/` |
| `npm run prefetch-check` | Verify all precached assets resolve correctly |
| `npm run reference:warmup` | Download the IWSDK reference corpus for AI code search |
| `npm run reference:status` | Check IWSDK reference corpus status |

## Testing the offline loop

1. Run `npm run dev` and enter the WebXR session at least once while online (this caches
   the config, models, and app shell).
2. Enable airplane mode (or use the "Airgap mode" toggle in the welcome panel).
3. Confirm the HUD banner reads **OFFLINE — 0 queued** and detection still runs.
4. Walk through detections, say "confirm" or press the A button on a pending detection.
5. Say "export" to download a CSV + manifest directly from the headset.

## Project structure

```
Sight2Sheet/
├── src/
│   ├── index.ts            # World.create() entry point, UI panels, system registration
│   ├── session.ts           # Session state machine — the fieldwork loop end to end
│   ├── camera.ts            # IWSDK CameraSource → frame supplier
│   ├── cv-pipeline.ts        # MediaPipe orchestrator (object detection + OCR handoff)
│   ├── detect-worker.ts      # Object detection running in a dedicated Web Worker
│   ├── coco-classes.ts       # COCO class labels for the detector
│   ├── config-store.ts       # Cached CV configs (IndexedDB) + rule-based fallback mapper
│   ├── llm-config.ts         # OpenRouter NL → CV config (online-mode only)
│   ├── network.ts            # ONLINE/OFFLINE state machine + Airgap-mode override
│   ├── db.ts                 # IndexedDB setup, persistent-storage request
│   ├── schema.ts              # CV config + finding record types/enums
│   ├── hud.ts                 # Passthrough overlays, queue counter, mode banner
│   ├── panel.ts                # Welcome panel wiring (start session, Airgap toggle)
│   ├── drag.ts                 # Grab-to-reposition handles for UI panels
│   ├── stt/
│   │   ├── stt.ts             # STT interface + router (vosk | deepgram | buttons)
│   │   ├── vosk-stt.ts         # On-device Vosk WASM speech-to-text
│   │   └── deepgram-stt.ts     # Online-mode Deepgram streaming STT
│   └── log/
│       ├── queue.ts            # IndexedDB findings queue
│       ├── exporter.ts         # CSV + JSON manifest Blob export
│       └── sync.ts             # Google Sheets append worker with retry/backoff
├── ui/
│   ├── welcome.uikitml         # Start panel + Airgap-mode toggle (source)
│   └── hud.uikitml             # HUD banner (source)
├── public/
│   ├── ui/                     # Compiled UIKitML output (welcome.json, hud.json)
│   ├── wasm/                   # MediaPipe + Tesseract WASM binaries (git-ignored)
│   └── models/                 # EfficientDet-Lite0, Tesseract eng data, Vosk model (git-ignored)
├── tools/
│   ├── fetch-assets.mjs        # Downloads/repacks all WASM + model assets
│   └── prefetch-check.js       # Verifies precached assets resolve
├── vite.config.ts               # IWSDK dev plugin, UIKitML compiler, PWA precache config
```

## Architecture at a glance

```
ONLINE (pre-mission)
  NL task description → OpenRouter LLM → CV Config JSON → IndexedDB
  Asset prefetch: MediaPipe/Tesseract/Vosk WASM + models → Cache Storage (Service Worker)

OFFLINE (in the gap)
  Quest 3 camera → MediaPipe ObjectDetector (worker) + Tesseract OCR
    → WebXR HUD overlay (class, confidence, OCR text, queue count)
    → Vosk WASM STT ("confirm"/"skip"/"note …"/"export") or controller buttons
    → IndexedDB findings queue → "export" → CSV + JSON manifest (on-device download)

ONLINE (post-mission)
  Sync worker: IndexedDB queue → Google Sheets API append → synced:true
```

Non-goals for this build: custom-trained detection models (COCO defaults + OCR only),
multi-user/multi-headset sessions, gesture confirmation, TTS voice feedback, and on-device
LLM inference.

## Citation

This project was presented at Sandia National Laboratories' 8th Annual XR Conference
(Albuquerque, NM, 2026). If you reference or build on this work, please cite:

> Mohammed Rashad. "Sight2Sheet: From Mixed Reality Walkthrough to Structured Inspection
> Record via On-Device Computer Vision." Presented at Sandia National Laboratories' 8th
> Annual XR Conference, Albuquerque, NM, 2026.

```bibtex
@inproceedings{rashad2026sight2sheet,
  author       = {Rashad, Mohammed},
  title        = {Sight2Sheet: From Mixed Reality Walkthrough to Structured Inspection
                  Record via On-Device Computer Vision},
  booktitle    = {Sandia National Laboratories' 8th Annual XR Conference},
  address      = {Albuquerque, NM},
  year         = {2026},
  affiliation  = {University of Illinois Urbana-Champaign}
}
```
