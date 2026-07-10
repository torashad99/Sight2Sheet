/**
 * Drag-to-move for UI panels: each panel gets a small grab bar under its
 * bottom edge. Point the controller ray at the bar, hold the trigger, and
 * move — the panel follows the ray at its grab-time distance, yaw-facing
 * the viewer. Release to park it in place.
 *
 * Built on InputSystem's Hovered/Pressed states rather than the grabbing
 * feature: DistanceGrabbable on the panel itself would hijack trigger
 * presses meant for the panel's buttons, and a dedicated handle sidesteps
 * that entirely.
 *
 * Dragging the HUD banner removes its head-locked Follower — the panel
 * becomes world-anchored wherever it's parked (re-entering XR re-locks it,
 * since HudSystem re-attaches the Follower on the visibility transition).
 */
import {
  createComponent,
  createSystem,
  DoubleSide,
  Follower,
  Hovered,
  InputComponent,
  Interactable,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Pressed,
  Quaternion,
  Types,
  Vector3,
  VisibilityState,
  type Entity,
  type Object3D,
  type World,
} from "@iwsdk/core";

const HANDLE_COLOR = 0x3f3f46;
const HANDLE_HOVER_COLOR = 0x22c55e;
const MIN_GRAB_DISTANCE = 0.4;
const MAX_GRAB_DISTANCE = 3;

export const DragHandle = createComponent("DragHandle", {
  /** The panel entity this handle moves. */
  target: { type: Types.Entity, default: null },
  /** Ray-to-panel distance captured at grab start. */
  grabDistance: { type: Types.Float32, default: 1 },
});

/** Creates the grab bar as a child of `panel`, `yOffset` meters below its
 * center (slightly in front, so it never z-fights the panel background). */
export function attachDragHandle(
  world: World,
  panel: Entity,
  yOffset: number,
): Entity {
  const mesh = new Mesh(
    new PlaneGeometry(0.16, 0.028),
    new MeshBasicMaterial({
      color: HANDLE_COLOR,
      transparent: true,
      opacity: 0.85,
      side: DoubleSide,
      depthTest: false,
    }),
  );
  const handle = world.createTransformEntity(mesh, panel);
  mesh.position.set(0, yOffset, 0.01);
  handle.addComponent(Interactable);
  handle.addComponent(DragHandle, { target: panel });
  return handle;
}

function setHandleColor(handle: Entity, hex: number): void {
  const mesh = handle.object3D as Mesh | undefined;
  const material = mesh?.material as MeshBasicMaterial | undefined;
  material?.color.setHex(hex);
}

export class DragSystem extends createSystem({
  pressed: { required: [DragHandle, Pressed] },
  hovered: { required: [DragHandle, Hovered] },
}) {
  private rayOrigin!: Vector3;
  private rayDir!: Vector3;
  private rayQuat!: Quaternion;
  private targetPos!: Vector3;
  private headPos!: Vector3;

  init() {
    this.rayOrigin = new Vector3();
    this.rayDir = new Vector3();
    this.rayQuat = new Quaternion();
    this.targetPos = new Vector3();
    this.headPos = new Vector3();

    this.queries.pressed.subscribe("qualify", (handle) => {
      const target = handle.getValue(DragHandle, "target") as Entity | null;
      const ray = this.activeRay();
      if (!target?.object3D || !ray) return;
      ray.getWorldPosition(this.rayOrigin);
      target.object3D.getWorldPosition(this.targetPos);
      const distance = Math.min(
        Math.max(this.rayOrigin.distanceTo(this.targetPos), MIN_GRAB_DISTANCE),
        MAX_GRAB_DISTANCE,
      );
      handle.setValue(DragHandle, "grabDistance", distance);
      // Dragging a head-locked panel takes ownership from its Follower.
      if (target.hasComponent(Follower)) {
        target.removeComponent(Follower);
      }
    });

    this.queries.hovered.subscribe("qualify", (handle) =>
      setHandleColor(handle, HANDLE_HOVER_COLOR),
    );
    this.queries.hovered.subscribe("disqualify", (handle) =>
      setHandleColor(handle, HANDLE_COLOR),
    );
  }

  update() {
    // ScreenSpace owns panel transforms in 2D browser mode; drag is XR-only.
    if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) {
      return;
    }

    for (const handle of this.queries.pressed.entities) {
      const target = handle.getValue(DragHandle, "target") as Entity | null;
      const ray = this.activeRay();
      if (!target?.object3D || !handle.object3D || !ray) continue;

      ray.getWorldPosition(this.rayOrigin);
      ray.getWorldQuaternion(this.rayQuat);
      this.rayDir.set(0, 0, -1).applyQuaternion(this.rayQuat);

      const distance =
        (handle.getValue(DragHandle, "grabDistance") as number | null) ?? 1;
      // The ray point is where the HANDLE should sit; the panel center is
      // one handle-offset above it (panels stay upright, so local Y ≈ world Y).
      const px = this.rayOrigin.x + this.rayDir.x * distance;
      const py =
        this.rayOrigin.y + this.rayDir.y * distance - handle.object3D.position.y;
      const pz = this.rayOrigin.z + this.rayDir.z * distance;
      target.object3D.position.set(px, py, pz);

      // Yaw-only face toward the viewer so text stays readable while parked.
      this.camera.getWorldPosition(this.headPos);
      target.object3D.rotation.set(
        0,
        Math.atan2(this.headPos.x - px, this.headPos.z - pz),
        0,
      );
    }
  }

  /** Ray space of whichever controller is holding its trigger. */
  private activeRay(): Object3D | null {
    const { left, right } = this.input.xr.gamepads;
    if (right?.getButtonPressed(InputComponent.Trigger)) {
      return this.player.raySpaces.right ?? null;
    }
    if (left?.getButtonPressed(InputComponent.Trigger)) {
      return this.player.raySpaces.left ?? null;
    }
    return this.player.raySpaces.right ?? null;
  }
}
