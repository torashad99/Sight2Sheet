/**
 * Session state machine — wires camera →
 * cv-pipeline → hud, and voice/button grammar → queue/export/sync. This is
 * the one system that owns the fieldwork loop end to end.
 *
 * State machine
 *
 *   IDLE --(enter XR)--> CONFIG_LOAD --> FIELDWORK <--> DETECT_PENDING
 *                                           |  ^              |
 *                                           |  |  confirm/skip/note
 *                                           |  +--------------+
 *                                           |
 *                                        "export"
 *                                           v
 *                                        EXPORT --> REVIEW --(online)--> SYNC --> DONE
 *                                                          --(offline)-----------> DONE
 */
import {
  createSystem,
  InputComponent,
  VisibilityState,
  Vector3,
  Quaternion,
} from "@iwsdk/core";
import { getActiveConfig, createFallbackConfig } from "./config-store.js";
import { createLLMConfig } from "./llm-config.js";
import { initCamera, cvCaptureSize, type CameraHandle } from "./camera.js";
import {
  preloadObjectDetector,
  preloadOcrWorker,
  detectObjectsAsync,
  runOcr,
  isOcrWorkerReady,
  disposeCVPipeline,
} from "./cv-pipeline.js";
import { HudSystem } from "./hud.js";
import { networkStateMachine } from "./network.js";
import { createSTTBackend, type STTBackend, type VoiceEvent } from "./stt/stt.js";
import { enqueueFinding, getUnsyncedCount } from "./log/queue.js";
import { exportSession } from "./log/exporter.js";
import { syncQueue } from "./log/sync.js";
import {
  isOcrPipeline,
  SessionState,
  VoiceCommand,
  type CVConfig,
  type DetectionInfo,
  type NetworkMode,
  type Pose,
  type SessionStateType,
} from "./schema.js";

// Minimum gap between detection-pass starts. Inference runs in the detection worker, so this
// paces work rather than protecting the render loop; ~5 passes/sec is
// plenty for a walkthrough. A pass already in flight also blocks starting
// the next one, so slow devices self-pace below this rate.
const DETECTION_MIN_INTERVAL_MS = 200;

// While a detection stays pending without a tag read yet (OCR warm-up, motion
// blur, regex miss on one frame), retry OCR with a fresh frame this often.
// The original one-shot-at-pending-time OCR silently never retried — the
// root cause of "tags don't show up" on-device.
const OCR_RETRY_INTERVAL_MS = 1200;

export class SessionSystem extends createSystem({}) {
  private state: SessionStateType = SessionState.Idle;
  private paused = false;

  private sessionId = "";
  private sessionStartMs = 0;
  private sessionCreatedAtIso = "";
  private activeConfig: CVConfig | null = null;

  private cameraHandle!: CameraHandle;
  private detectInFlight = false;
  private lastDetectStartMs = 0;
  private lastFrameCanvas: HTMLCanvasElement | null = null;

  private currentDetections: DetectionInfo[] = [];
  private pendingIndex: number | null = null;
  private ocrTextByIndex: Partial<Record<number, string | null>> = {};
  private ocrInFlight = false;
  private lastOcrAttemptMs = 0;
  private lastFrameW = 0;
  private lastFrameH = 0;

  private sttBackend: STTBackend | null = null;
  private networkMode: NetworkMode = "offline";

  private tempPos!: Vector3;
  private tempQuat!: Quaternion;

  private unsubscribeNetwork: (() => void) | null = null;
  private unsubscribeVisibility: (() => void) | null = null;

  init() {
    this.tempPos = new Vector3();
    this.tempQuat = new Quaternion();
    this.cameraHandle = initCamera(this.world);

    this.unsubscribeNetwork = networkStateMachine.subscribe((mode) => {
      this.networkMode = mode;
      void this.refreshBanner();
    });

    this.unsubscribeVisibility = this.world.visibilityState.subscribe(
      (state) => {
        if (state === VisibilityState.Visible && this.state === SessionState.Idle) {
          void this.beginSession();
        } else if (state === VisibilityState.Hidden) {
          this.teardownFieldwork();
        }
      },
    );

    this.cleanupFuncs.push(() => this.unsubscribeNetwork?.());
    this.cleanupFuncs.push(() => this.unsubscribeVisibility?.());
    this.cleanupFuncs.push(() => this.teardownFieldwork());
  }

  update() {
    if (
      this.state !== SessionState.Fieldwork &&
      this.state !== SessionState.DetectPending
    ) {
      return;
    }

    // Controller confirm/skip always active —
    // A=confirm, B=skip on the right Touch controller.
    const rightGamepad = this.input.xr.gamepads.right;
    if (rightGamepad?.getButtonDown(InputComponent.A_Button)) {
      void this.handleConfirm();
    } else if (rightGamepad?.getButtonDown(InputComponent.B_Button)) {
      this.handleSkip();
    }

    if (this.paused) return;
    if (this.detectInFlight) return;
    const now = performance.now();
    if (now - this.lastDetectStartMs < DETECTION_MIN_INTERVAL_MS) return;

    const video = this.cameraHandle.getVideo();
    if (!video) return;

    this.detectInFlight = true;
    this.lastDetectStartMs = now;
    void this.runDetectionPass(video);
  }

  /**
   * One async detection pass: downscale the current camera frame into an
   * ImageBitmap (GPU-side, no main-thread readback) and hand it to the
   * detection worker. The render loop never blocks on inference — this is
   * the fix for the on-device UI stutter.
   */
  private async runDetectionPass(video: HTMLVideoElement): Promise<void> {
    try {
      const { w, h } = cvCaptureSize(video.videoWidth, video.videoHeight);
      const bitmap = await createImageBitmap(video, {
        resizeWidth: w,
        resizeHeight: h,
      });
      const detections = await detectObjectsAsync(bitmap);
      // Session may have ended/torn down while the pass was in flight.
      if (
        this.state !== SessionState.Fieldwork &&
        this.state !== SessionState.DetectPending
      ) {
        return;
      }
      this.applyDetections(detections, w, h);
    } catch (error) {
      console.warn("[session] detection pass failed:", error);
    } finally {
      this.detectInFlight = false;
    }
  }

  private applyDetections(
    detections: DetectionInfo[],
    frameWidth: number,
    frameHeight: number,
  ): void {
    this.currentDetections = detections;
    this.lastFrameW = frameWidth;
    this.lastFrameH = frameHeight;

    if (detections.length === 0) {
      if (this.pendingIndex !== null) this.clearPending();
    } else if (this.pendingIndex === null) {
      this.pendingIndex = 0;
      this.state = SessionState.DetectPending;
      // Capture a frame for the confirm blob now that a detection is
      // pending. It's ~one detection interval newer than the frame the bbox
      // came from; close enough for an evidence snapshot.
      this.lastFrameCanvas = this.cameraHandle.getFrameCanvas();
    }

    // Run/retry OCR while a detection is pending and no tag has been read
    // yet — first frames often miss (worker warm-up, motion blur), so keep
    // trying with fresh frames instead of the old one-shot-then-give-up.
    if (
      this.pendingIndex !== null &&
      !this.ocrTextByIndex[this.pendingIndex] &&
      !this.ocrInFlight &&
      performance.now() - this.lastOcrAttemptMs > OCR_RETRY_INTERVAL_MS
    ) {
      void this.runPendingOcr();
    }

    // Surface tag-reading progress on the pending label ("reading tag…")
    // so OCR-in-progress is distinguishable from OCR-found-nothing.
    let pendingOcrStatus: string | null = null;
    if (
      this.pendingIndex !== null &&
      !this.ocrTextByIndex[this.pendingIndex] &&
      this.activeConfig?.pipelines.some(isOcrPipeline)
    ) {
      pendingOcrStatus = isOcrWorkerReady() ? "reading tag…" : "OCR warming up…";
    }

    const hud = this.world.getSystem(HudSystem);
    hud?.setDetections(
      detections,
      frameWidth,
      frameHeight,
      this.pendingIndex,
      this.ocrTextByIndex,
      pendingOcrStatus,
    );
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  private async beginSession(): Promise<void> {
    this.state = SessionState.ConfigLoad;
    this.sessionId = crypto.randomUUID();
    this.sessionStartMs = performance.now();
    this.sessionCreatedAtIso = new Date().toISOString();

    this.activeConfig = await getActiveConfig();

    // CV warm-up blocks entry into FIELDWORK (needed before detection can
    // run at all); OCR and STT are lazily warmed up *after*, in the
    // background (avoid wasm-init memory
    // pressure colliding, and don't delay the first detections on STT init).
    const detectorOk = await preloadObjectDetector(this.activeConfig);
    if (!detectorOk) {
      console.error(
        "[session] object detector unavailable — fieldwork continues without detection (voice notes/export still work)",
      );
    }

    this.state = SessionState.Fieldwork;
    console.info("[session] fieldwork started");
    await this.refreshBanner();

    void preloadOcrWorker();
    void this.initSTT();
  }

  private async initSTT(): Promise<void> {
    this.sttBackend = await createSTTBackend(
      this.networkMode,
      (event) => this.handleVoiceEvent(event),
      // Partial results give instant "the mic heard you" feedback — final
      // recognition (silence endpointing) can lag utterances by seconds.
      (partial) => this.toast(`hearing "${partial}"…`, 1500),
    );
  }

  /** Transient acknowledgement line on the HUD banner. */
  private toast(text: string, ttlMs?: number): void {
    this.world.getSystem(HudSystem)?.showStatus(text, ttlMs);
  }

  /** CONFIG_LLM / CONFIG_FALLBACK: define a new task while in session.
   * Exposed for a future "configure new task" UI hook (not wired to input
   * in this build — the seeded/cached config is the default entry point). */
  async requestNewConfig(taskDescription: string): Promise<CVConfig> {
    if (this.networkMode === "online") {
      const llmConfig = await createLLMConfig(taskDescription);
      if (llmConfig) {
        this.activeConfig = llmConfig;
        await preloadObjectDetector(llmConfig);
        return llmConfig;
      }
    }
    const fallback = await createFallbackConfig(taskDescription);
    this.activeConfig = fallback;
    await preloadObjectDetector(fallback);
    return fallback;
  }

  private teardownFieldwork(): void {
    this.sttBackend?.stop();
    this.sttBackend = null;
    disposeCVPipeline();
    this.clearPending();
    this.currentDetections = [];
    this.detectInFlight = false;
    this.lastFrameCanvas = null;
    if (this.state !== SessionState.Idle) {
      this.state = SessionState.Idle;
    }
  }

  // ---------------------------------------------------------------------
  // Voice / button grammar
  // ---------------------------------------------------------------------

  private handleVoiceEvent(event: VoiceEvent): void {
    this.toast(`heard "${event.command}"`);
    switch (event.command) {
      case VoiceCommand.Confirm:
        void this.handleConfirm();
        break;
      case VoiceCommand.Skip:
        this.handleSkip();
        break;
      case VoiceCommand.Note:
        // "note <text>" both annotates and confirms the pending detection
        // (or logs a note-only finding if nothing is pending) — matches the
        // which pairs a detection with a voice_note.
        void this.handleConfirm(event.freeText ?? null);
        break;
      case VoiceCommand.Pause:
        this.paused = true;
        this.toast("detection paused");
        break;
      case VoiceCommand.Resume:
        this.paused = false;
        this.toast("detection resumed");
        break;
      case VoiceCommand.Export:
        void this.handleExport();
        break;
      case VoiceCommand.Status:
        void this.refreshBanner();
        break;
    }
  }

  private async handleConfirm(voiceNote: string | null = null): Promise<void> {
    const hasPending =
      this.state === SessionState.DetectPending && this.pendingIndex !== null;
    if (!hasPending && !voiceNote) {
      this.toast("nothing to confirm");
      return;
    }
    if (!this.activeConfig) return;
    this.toast("logging finding…");

    const detection = hasPending
      ? this.currentDetections[this.pendingIndex!]
      : null;
    const ocrText = hasPending
      ? (this.ocrTextByIndex[this.pendingIndex!] ?? null)
      : null;
    // Pending confirms use the frame captured when the detection became
    // pending (the frame the bbox/OCR describe); note-only findings have no
    // pending frame, so grab a fresh one.
    const frameCanvas = hasPending
      ? this.lastFrameCanvas
      : this.cameraHandle.getFrameCanvas();

    await enqueueFinding({
      sessionId: this.sessionId,
      configId: this.activeConfig.config_id,
      sessionStartMs: this.sessionStartMs,
      pose: this.capturePose(),
      detection: detection ?? null,
      ocrText,
      voiceNote,
      frameCanvas,
    });

    this.clearPending();
    await this.refreshBanner();
    this.toast("finding logged ✓");
  }

  private handleSkip(): void {
    if (this.pendingIndex !== null) this.toast("skipped");
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingIndex = null;
    this.ocrTextByIndex = {};
    if (this.state === SessionState.DetectPending) {
      this.state = SessionState.Fieldwork;
    }
  }

  private async runPendingOcr(): Promise<void> {
    const index = this.pendingIndex;
    if (index === null || !this.activeConfig || this.ocrInFlight) return;
    const ocrPipeline = this.activeConfig.pipelines.find(isOcrPipeline);
    if (!ocrPipeline || !isOcrWorkerReady()) return;

    // OCR reads from the FULL-resolution frame: tag text in the 320px CV
    // frame is ~10px tall, below Tesseract's reliable range. The detection
    // bbox is in CV-frame pixels, so scale it up to full-res coordinates.
    const fullFrame = this.cameraHandle.getFullFrameCanvas();
    if (!fullFrame) return;
    const detection = this.currentDetections[index];
    let bbox = detection?.bbox ?? null;
    if (bbox && this.lastFrameW > 0 && this.lastFrameH > 0) {
      const sx = fullFrame.width / this.lastFrameW;
      const sy = fullFrame.height / this.lastFrameH;
      bbox = [bbox[0] * sx, bbox[1] * sy, bbox[2] * sx, bbox[3] * sy];
    }

    this.ocrInFlight = true;
    this.lastOcrAttemptMs = performance.now();
    try {
      const text = await runOcr(ocrPipeline, fullFrame, bbox);
      // Pending detection may have changed/cleared while OCR was running;
      // only store hits — a null keeps the retry loop going.
      if (this.pendingIndex === index && text) {
        this.ocrTextByIndex[index] = text;
      }
    } finally {
      this.ocrInFlight = false;
    }
  }

  private capturePose(): Pose {
    this.player.head.getWorldPosition(this.tempPos);
    this.player.head.getWorldQuaternion(this.tempQuat);
    return {
      x: this.tempPos.x,
      y: this.tempPos.y,
      z: this.tempPos.z,
      qx: this.tempQuat.x,
      qy: this.tempQuat.y,
      qz: this.tempQuat.z,
      qw: this.tempQuat.w,
    };
  }

  // ---------------------------------------------------------------------
  // Export / sync
  // ---------------------------------------------------------------------

  private async handleExport(): Promise<void> {
    if (!this.activeConfig || !this.sessionId) return;
    const previousState = this.state;
    this.state = SessionState.Export;
    this.toast("exporting…", 8000);

    await exportSession({
      sessionId: this.sessionId,
      sessionCreatedAt: this.sessionCreatedAtIso,
      config: this.activeConfig,
      networkMode: this.networkMode,
    });

    this.state = SessionState.Review;
    this.toast("export downloaded ✓");
    if (this.networkMode === "online") {
      this.state = SessionState.Sync;
      await syncQueue();
      await this.refreshBanner();
    }
    this.state = SessionState.Done;

    // Fieldwork can resume after an export — return to whatever state made sense.
    this.state =
      previousState === SessionState.DetectPending
        ? SessionState.Fieldwork
        : previousState;
  }

  private async refreshBanner(): Promise<void> {
    const count = await getUnsyncedCount();
    const hud = this.world.getSystem(HudSystem);
    hud?.setBanner(this.networkMode, count);
  }
}
