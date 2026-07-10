/**
 * Passthrough HUD: per-detection bounding-box + label
 * overlays, and a fixed mode banner ("OFFLINE — N queued").
 *
 * Spatial-alignment approximation: the CameraSource feed (getUserMedia) has
 * no exposed intrinsics/extrinsics relative to the headset pose, so exact
 * pixel-to-world reprojection isn't available. Overlays are instead rendered
 * on a plane a fixed distance in front of `this.camera`, mapped from the
 * detection's normalized position in the camera frame using an assumed
 * horizontal FOV. This tracks head movement every frame (feels spatial) but
 * does not anchor to the physical object across frames (no SLAM) — a
 * reasonable MVP tradeoff given the camera is mounted close to the visor.
 *
 * Overlay calibration: the physical passthrough camera is displaced/tilted
 * relative to the render camera, which shows up as a constant angular bias
 * (boxes drawn up-left of the real object on-device). While overlays are
 * visible, the RIGHT THUMBSTICK nudges a yaw/pitch correction (push toward
 * where the box should move); values persist in localStorage and are logged
 * so good values can be baked into the defaults below.
 *
 * The mode banner is a UIKit PanelUI panel (`ui/hud.uikitml`) rather than a
 * 3D canvas plane — simpler text updates via PanelDocument, consistent with
 * the welcome panel's existing pattern (panel.ts). In immersive XR its
 * ScreenSpace layout is inert (IWSDK returns ScreenSpace panels to world
 * space on session start), so HudSystem attaches a head-locked Follower for
 * the duration of the XR session — without it the banner sat at the world
 * origin, invisible on-device.
 */
import {
  createSystem,
  eq,
  Follower,
  FollowBehavior,
  InputComponent,
  PanelUI,
  PanelDocument,
  Vector3,
  Quaternion,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  LineLoop,
  LineBasicMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  CanvasTexture,
  DoubleSide,
  VisibilityState,
  type Entity,
  type UIKitDocument,
  UIKit,
} from "@iwsdk/core";
import type { DetectionInfo, NetworkMode } from "./schema.js";

const MAX_OVERLAYS = 6;
const OVERLAY_DISTANCE = 1.4; // meters in front of camera
const ASSUMED_HFOV_DEG = 62; // approximate passthrough camera horizontal FOV
const LABEL_CANVAS_W = 256;
const LABEL_CANVAS_H = 96;

// Overlay calibration (see file header). Positive yaw shifts overlays to the
// viewer's right, positive pitch shifts them up. Defaults were tuned live on
// a Quest 3 via the right-thumbstick flow (2026-07); on-device thumbstick
// tuning still overrides them via localStorage.
const DEFAULT_CAL_YAW_DEG = 3.3;
const DEFAULT_CAL_PITCH_DEG = -13.1;
const CAL_STORAGE_KEY = "s2s-overlay-cal";
const CAL_RATE_DEG_PER_SEC = 8;
const CAL_DEADZONE = 0.3;
const DEG2RAD = Math.PI / 180;

interface OverlayBoxData {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  aspect: number;
}

interface OverlayHandle {
  boxEntity: Entity;
  labelEntity: Entity;
  box: LineLoop;
  label: Mesh;
  boxMaterial: LineBasicMaterial;
  labelCanvas: HTMLCanvasElement;
  labelCtx: CanvasRenderingContext2D;
  labelTexture: CanvasTexture;
  lastLabelText: string;
  data: OverlayBoxData;
}

function createUnitBoxLineLoop(): { box: LineLoop; material: LineBasicMaterial } {
  const geometry = new BufferGeometry();
  const half = 0.5;
  const positions = new Float32Array([
    -half, -half, 0,
    half, -half, 0,
    half, half, 0,
    -half, half, 0,
  ]);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const material = new LineBasicMaterial({ color: 0x22c55e });
  return { box: new LineLoop(geometry, material), material };
}

function createLabelMesh(): {
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
} {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_CANVAS_W;
  canvas.height = LABEL_CANVAS_H;
  const ctx = canvas.getContext("2d")!;
  const texture = new CanvasTexture(canvas);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: DoubleSide,
    depthTest: false,
  });
  const mesh = new Mesh(new PlaneGeometry(0.24, 0.09), material);
  return { mesh, canvas, ctx, texture };
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string,
  pending: boolean,
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = pending ? "rgba(234, 179, 8, 0.94)" : "rgba(9, 9, 11, 0.85)";
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 10);
  ctx.fill();
  ctx.fillStyle = pending ? "#09090b" : "#fafafa";
  ctx.font = "bold 22px sans-serif";
  ctx.textBaseline = "top";
  const lines = text.split("\n");
  lines.forEach((line, i) => ctx.fillText(line, 10, 8 + i * 26, canvas.width - 20));
}

export class HudSystem extends createSystem({
  hudPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/hud.json")],
  },
}) {
  private overlays: OverlayHandle[] = [];
  private activeCount = 0;

  private tempPos!: Vector3;
  private tempQuat!: Quaternion;
  private tempForward!: Vector3;
  private tempRight!: Vector3;
  private tempUp!: Vector3;

  private modeText: UIKit.Text | null = null;
  private queueText: UIKit.Text | null = null;
  private statusText: UIKit.Text | null = null;
  private statusClearTimer: ReturnType<typeof setTimeout> | null = null;

  private hudPanelEntity: Entity | null = null;
  private immersive = false;

  private calYawDeg = DEFAULT_CAL_YAW_DEG;
  private calPitchDeg = DEFAULT_CAL_PITCH_DEG;
  private calDirty = false;
  private lastCalPersistMs = 0;

  init() {
    this.tempPos = new Vector3();
    this.tempQuat = new Quaternion();
    this.tempForward = new Vector3();
    this.tempRight = new Vector3();
    this.tempUp = new Vector3();

    this.loadCalibration();

    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const { box, material: boxMaterial } = createUnitBoxLineLoop();
      const { mesh: label, canvas, ctx, texture } = createLabelMesh();
      box.visible = false;
      label.visible = false;

      const boxEntity = this.world.createTransformEntity(box);
      const labelEntity = this.world.createTransformEntity(label);

      this.overlays.push({
        boxEntity,
        labelEntity,
        box,
        label,
        boxMaterial,
        labelCanvas: canvas,
        labelCtx: ctx,
        labelTexture: texture,
        lastLabelText: "",
        data: { nx: 0, ny: 0, nw: 0.1, nh: 0.1, aspect: 4 / 3 },
      });
    }

    this.queries.hudPanel.subscribe("qualify", (entity) => {
      this.hudPanelEntity = entity;
      const document = PanelDocument.data.document[
        entity.index
      ] as UIKitDocument;
      if (document) {
        this.modeText = document.getElementById("mode-text") as UIKit.Text;
        this.queueText = document.getElementById("queue-text") as UIKit.Text;
        this.statusText = document.getElementById("status-text") as UIKit.Text;
      }
      // Panel may qualify (document load is async) after XR already started.
      if (this.immersive) this.attachBannerFollower();
    });

    this.cleanupFuncs.push(() => {
      if (this.statusClearTimer) clearTimeout(this.statusClearTimer);
    });

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.immersive =
          state === VisibilityState.Visible ||
          state === VisibilityState.VisibleBlurred;
        // Head-lock the banner only while immersive; in 2D browser mode the
        // ScreenSpaceUISystem owns the panel transform and the two systems
        // would fight over it.
        if (this.immersive) {
          this.attachBannerFollower();
        } else {
          this.detachBannerFollower();
        }
      }),
    );
  }

  private attachBannerFollower(): void {
    const entity = this.hudPanelEntity;
    if (!entity || entity.hasComponent(Follower)) return;
    entity.addComponent(Follower, {
      target: this.player.head,
      // Head-local: ~15° above forward at 1.15m — top of view, not blocking
      // the inspection sightline.
      offsetPosition: [0, 0.3, -1.15],
      behavior: FollowBehavior.PivotY,
      speed: 5,
      tolerance: 0.2,
      maxAngle: 25,
    });
  }

  private detachBannerFollower(): void {
    const entity = this.hudPanelEntity;
    if (entity?.hasComponent(Follower)) {
      entity.removeComponent(Follower);
    }
  }

  /** Right-thumbstick overlay calibration (see file header). Only active
   * while overlays are visible — alignment is only judgeable then. */
  private updateCalibration(delta: number): void {
    const axes = this.input.xr.gamepads.right?.getAxesValues(
      InputComponent.Thumbstick,
    );
    if (!axes) return;
    const ax = Math.abs(axes.x) > CAL_DEADZONE ? axes.x : 0;
    const ay = Math.abs(axes.y) > CAL_DEADZONE ? axes.y : 0;
    if (ax !== 0 || ay !== 0) {
      this.calYawDeg += ax * CAL_RATE_DEG_PER_SEC * delta;
      // Thumbstick up is -Y in WebXR; up should raise the overlays.
      this.calPitchDeg += -ay * CAL_RATE_DEG_PER_SEC * delta;
      this.calDirty = true;
    }
    if (this.calDirty && performance.now() - this.lastCalPersistMs > 1000) {
      this.lastCalPersistMs = performance.now();
      this.calDirty = false;
      this.persistCalibration();
    }
  }

  private loadCalibration(): void {
    try {
      const raw = localStorage.getItem(CAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { yaw?: number; pitch?: number };
      if (typeof parsed.yaw === "number") this.calYawDeg = parsed.yaw;
      if (typeof parsed.pitch === "number") this.calPitchDeg = parsed.pitch;
    } catch {
      // Corrupt/blocked storage — keep defaults.
    }
  }

  private persistCalibration(): void {
    try {
      localStorage.setItem(
        CAL_STORAGE_KEY,
        JSON.stringify({ yaw: this.calYawDeg, pitch: this.calPitchDeg }),
      );
    } catch {
      // Storage unavailable — tuning still applies for this session.
    }
    console.log(
      `[hud] overlay calibration yaw=${this.calYawDeg.toFixed(1)}° pitch=${this.calPitchDeg.toFixed(1)}° (bake into DEFAULT_CAL_*_DEG once dialed in)`,
    );
  }

  update(delta: number) {
    if (this.activeCount === 0) return;

    this.updateCalibration(delta);

    this.camera.getWorldPosition(this.tempPos);
    this.camera.getWorldQuaternion(this.tempQuat);
    this.tempForward.set(0, 0, -1).applyQuaternion(this.tempQuat);
    this.tempRight.set(1, 0, 0).applyQuaternion(this.tempQuat);
    this.tempUp.set(0, 1, 0).applyQuaternion(this.tempQuat);

    const planeWidth =
      2 * OVERLAY_DISTANCE * Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360);
    const calX = OVERLAY_DISTANCE * Math.tan(this.calYawDeg * DEG2RAD);
    const calY = OVERLAY_DISTANCE * Math.tan(this.calPitchDeg * DEG2RAD);

    for (let i = 0; i < this.activeCount; i++) {
      const overlay = this.overlays[i];
      const { nx, ny, nw, nh, aspect } = overlay.data;
      const planeHeight = planeWidth / aspect;

      const localX = (nx + nw / 2 - 0.5) * planeWidth + calX;
      const localY = -(ny + nh / 2 - 0.5) * planeHeight + calY;

      const px =
        this.tempPos.x +
        this.tempForward.x * OVERLAY_DISTANCE +
        this.tempRight.x * localX +
        this.tempUp.x * localY;
      const py =
        this.tempPos.y +
        this.tempForward.y * OVERLAY_DISTANCE +
        this.tempRight.y * localX +
        this.tempUp.y * localY;
      const pz =
        this.tempPos.z +
        this.tempForward.z * OVERLAY_DISTANCE +
        this.tempRight.z * localX +
        this.tempUp.z * localY;

      overlay.box.position.set(px, py, pz);
      overlay.box.quaternion.copy(this.tempQuat);
      overlay.box.scale.set(nw * planeWidth, nh * planeHeight, 1);

      overlay.label.position.set(
        px + this.tempUp.x * (nh * planeHeight * 0.5 + 0.06),
        py + this.tempUp.y * (nh * planeHeight * 0.5 + 0.06),
        pz + this.tempUp.z * (nh * planeHeight * 0.5 + 0.06),
      );
      overlay.label.quaternion.copy(this.tempQuat);
    }
  }

  /**
   * Updates per-detection overlays. `pendingIndex` (if set) is rendered
   * highlighted — the DETECT_PENDING "overlay highlighted, awaiting
   * voice/button" state. `ocrTextByIndex` maps detection index -> OCR text
   * to append to that detection's label. `pendingOcrStatus` (e.g. "reading
   * tag…") is shown on the pending label while OCR hasn't produced a tag
   * yet, so tag-reading is visibly in progress rather than silently absent.
   */
  setDetections(
    detections: DetectionInfo[],
    frameWidth: number,
    frameHeight: number,
    pendingIndex: number | null,
    ocrTextByIndex?: Partial<Record<number, string | null>>,
    pendingOcrStatus?: string | null,
  ): void {
    const aspect = frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : 4 / 3;
    this.activeCount = Math.min(detections.length, MAX_OVERLAYS);

    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const overlay = this.overlays[i];
      if (i >= this.activeCount) {
        overlay.box.visible = false;
        overlay.label.visible = false;
        continue;
      }

      const det = detections[i];
      const [x, y, w, h] = det.bbox;
      overlay.data.nx = x / frameWidth;
      overlay.data.ny = y / frameHeight;
      overlay.data.nw = w / frameWidth;
      overlay.data.nh = h / frameHeight;
      overlay.data.aspect = aspect;

      const isPending = pendingIndex === i;
      overlay.boxMaterial.color.set(isPending ? 0xeab308 : 0x22c55e);
      overlay.box.visible = true;
      overlay.label.visible = true;

      const ocr = ocrTextByIndex?.[i];
      // Score bucketed to 5% steps: raw scores jitter every pass, and each
      // text change costs a canvas redraw + GPU texture upload.
      const scorePct = Math.round(det.score * 20) * 5;
      const secondLine = ocr ?? (isPending ? pendingOcrStatus : null);
      const text = `${det.class} ${scorePct}%${secondLine ? `\n${secondLine}` : ""}`;
      if (text !== overlay.lastLabelText) {
        drawLabel(overlay.labelCtx, overlay.labelCanvas, text, isPending);
        overlay.labelTexture.needsUpdate = true;
        overlay.lastLabelText = text;
      }
    }
  }

  /**
   * Transient status line on the banner — immediate feedback for voice
   * commands and actions ("heard confirm", "exporting…"), bridging the gap
   * between an utterance and its visible effect. Auto-clears after `ttlMs`.
   */
  showStatus(text: string, ttlMs = 2500): void {
    console.debug("[hud] status:", text, this.statusText ? "" : "(no element!)");
    this.statusText?.setProperties({ text });
    if (this.statusClearTimer) clearTimeout(this.statusClearTimer);
    this.statusClearTimer = setTimeout(() => {
      this.statusText?.setProperties({ text: " " });
      this.statusClearTimer = null;
    }, ttlMs);
  }

  /** HUD banner: "{ONLINE|OFFLINE} — N queued" */
  setBanner(mode: NetworkMode, queuedCount: number): void {
    this.modeText?.setProperties({
      text: mode === "offline" ? "OFFLINE" : "ONLINE",
    });
    this.queueText?.setProperties({ text: `${queuedCount} queued` });
  }

  clearDetections(): void {
    this.activeCount = 0;
    for (const overlay of this.overlays) {
      overlay.box.visible = false;
      overlay.label.visible = false;
    }
  }
}
