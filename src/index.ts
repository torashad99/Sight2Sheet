/**
 * Sight2Sheet boot: World.create() with passthrough AR +
 * camera access, the start/Airgap-toggle panel, the HUD banner panel, and
 * the Sight2Sheet systems. No static GLTF/audio content — everything here
 * is either UI or driven by the CV/STT/logging pipeline at runtime.
 */
import {
  Interactable,
  PanelUI,
  ScreenSpace,
  SessionMode,
  World,
} from "@iwsdk/core";

import { PanelSystem } from "./panel.js";
import { HudSystem } from "./hud.js";
import { SessionSystem } from "./session.js";
import { DragSystem, attachDragHandle } from "./drag.js";
import { networkStateMachine } from "./network.js";
import { requestPersistentStorage } from "./db.js";

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: "always",
    // No hand tracking / anchors / plane / mesh detection — voice + button
    // confirm only, and
    // findings are logged with viewer pose, not spatially anchored content.
  },
  features: {
    locomotion: false,
    grabbing: false,
    physics: false,
    sceneUnderstanding: false,
    environmentRaycast: false,
    // REQUIRED: without this, CameraSystem never registers and
    // CameraSource stays permanently Inactive
    camera: true,
  },
}).then((world) => {
  // keep cached models/queue from being evicted
  // under storage pressure. Best-effort; not all browsers honor it.
  void requestPersistentStorage();

  // starts the 30s connectivity probe + online/offline listeners.
  networkStateMachine.start();

  const startPanel = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/welcome.json",
      maxHeight: 0.8,
      maxWidth: 1.6,
    })
    .addComponent(Interactable)
    .addComponent(ScreenSpace, {
      top: "20px",
      left: "20px",
      height: "40%",
    });
  startPanel.object3D!.position.set(0, 1.29, -1.9);
  // Grab bar below the panel: point + hold trigger to drag it anywhere.
  attachDragHandle(world, startPanel, -0.46);

  // HUD banner: "{OFFLINE|ONLINE} — N queued", top-right in
  // 2D via ScreenSpace; in immersive XR (where ScreenSpace goes inert)
  // HudSystem head-locks it with a Follower. Passive display, deliberately
  // not Interactable.
  const hudPanel = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/hud.json",
      maxHeight: 0.22,
      maxWidth: 0.7,
    })
    .addComponent(ScreenSpace, {
      top: "20px",
      right: "20px",
      height: "10%",
    });
  // Fallback world placement so the panel is never at the floor-level world
  // origin if it renders before the Follower's first sync.
  hudPanel.object3D!.position.set(0, 1.6, -1.2);
  // Dragging the banner detaches its head-lock and parks it in the world
  // (DragSystem removes the Follower on grab).
  attachDragHandle(world, hudPanel, -0.15);

  world
    .registerSystem(PanelSystem)
    .registerSystem(HudSystem)
    .registerSystem(SessionSystem)
    .registerSystem(DragSystem);
});
