/**
 * Thin wrapper around IWSDK's built-in camera module.
 * IWSDK 0.4.2 ships CameraSource/CameraSystem/CameraUtils
 * (@iwsdk/core/dist/camera/*) backed by `getUserMedia` — this is Quest's
 * Passthrough Camera API path, and the risk table's "known-good getUserMedia
 * fallback" turns out to already be the primary IWSDK path, so
 * there's no separate raw-WebXR-camera integration needed here.
 *
 * Two capture paths, on purpose:
 * - Detection passes use `getVideo()` + `createImageBitmap(video, {resize…})`
 *   on the caller side — async, GPU-side scaling, no main-thread canvas
 *   readback — and transfer the bitmap to the detection worker.
 * - `getFrameCanvas()` draws into one persistent, reused 2D canvas
 *   (`willReadFrequently`, a synchronous CPU readback). That cost is fine at
 *   its actual cadence — once per pending detection for OCR / the confirm
 *   frame blob — but it's exactly what stuttered the render loop when it ran
 *   per detection pass, so keep it OFF the detection path.
 *
 * Both paths downscale to the same CV_FRAME_MAX_DIM box, so
 * detection bboxes and OCR crops share one pixel space.
 */
import {
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  type Entity,
  type World,
} from "@iwsdk/core";

/** Longest edge of the CV-pipeline frame */
export const CV_FRAME_MAX_DIM = 320;

/** Downscaled capture size for a video of the given dimensions. */
export function cvCaptureSize(
  videoWidth: number,
  videoHeight: number,
): { w: number; h: number } {
  const scale = Math.min(1, CV_FRAME_MAX_DIM / Math.max(videoWidth, videoHeight));
  return {
    w: Math.max(1, Math.round(videoWidth * scale)),
    h: Math.max(1, Math.round(videoHeight * scale)),
  };
}

export interface CameraHandle {
  entity: Entity;
  isActive(): boolean;
  /** The live camera video element, or null until the stream is active and
   * has produced a frame. For the detection path (createImageBitmap). */
  getVideo(): HTMLVideoElement | null;
  /** Draws the current camera frame into a reused, downscaled canvas.
   * Synchronous readback — for the occasional frame-blob capture only,
   * never per detection pass. Returns null until the stream is active. */
  getFrameCanvas(): HTMLCanvasElement | null;
  /** Draws the current camera frame into a reused canvas at NATIVE video
   * resolution. For OCR: tag text is ~10px tall in the downscaled CV frame,
   * below Tesseract's reliable range — OCR needs the full-res pixels. Same
   * occasional-use-only caveat as getFrameCanvas. */
  getFullFrameCanvas(): HTMLCanvasElement | null;
}

export function initCamera(world: World): CameraHandle {
  const entity = world.createTransformEntity();

  // Only attach CameraSource once a camera is known to exist. IWSDK's
  // CameraSystem retries a camera in Error state EVERY FRAME, so attaching
  // the component in an environment where the camera can never start (e.g.
  // the agent/emulator browser has no Media Capture support) floods the
  // console at ~120 errors/sec and buries all other logs.
  void (async () => {
    try {
      const devices = await CameraUtils.getDevices();
      if (devices.length === 0) {
        console.warn("[camera] no camera devices — detection disabled");
        return;
      }
      entity.addComponent(CameraSource, {
        facing: CameraFacing.Back,
        width: 640,
        height: 480,
        frameRate: 30,
      });
    } catch {
      console.warn(
        "[camera] camera enumeration unavailable in this browser — detection disabled",
      );
    }
  })();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const fullCanvas = document.createElement("canvas");
  const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });

  function isActive(): boolean {
    return (
      entity.hasComponent(CameraSource) &&
      entity.getValue(CameraSource, "state") === CameraState.Active
    );
  }

  function getVideo(): HTMLVideoElement | null {
    if (!isActive()) return null;
    const video = entity.getValue(
      CameraSource,
      "videoElement",
    ) as HTMLVideoElement | null;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    return video;
  }

  function getFrameCanvas(): HTMLCanvasElement | null {
    const video = getVideo();
    if (!ctx || !video) return null;

    const { w, h } = cvCaptureSize(video.videoWidth, video.videoHeight);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }

  function getFullFrameCanvas(): HTMLCanvasElement | null {
    const video = getVideo();
    if (!fullCtx || !video) return null;

    if (
      fullCanvas.width !== video.videoWidth ||
      fullCanvas.height !== video.videoHeight
    ) {
      fullCanvas.width = video.videoWidth;
      fullCanvas.height = video.videoHeight;
    }
    fullCtx.drawImage(video, 0, 0);
    return fullCanvas;
  }

  return { entity, isActive, getVideo, getFrameCanvas, getFullFrameCanvas };
}
