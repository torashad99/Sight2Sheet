import {
  createSystem,
  PanelUI,
  PanelDocument,
  eq,
  VisibilityState,
  UIKitDocument,
  UIKit,
} from "@iwsdk/core";
import { networkStateMachine } from "./network.js";
import { clearQueue, getUnsyncedCount } from "./log/queue.js";
import { HudSystem } from "./hud.js";

export class PanelSystem extends createSystem({
  welcomePanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/welcome.json")],
  },
}) {
  init() {
    this.queries.welcomePanel.subscribe("qualify", (entity) => {
      const document = PanelDocument.data.document[
        entity.index
      ] as UIKitDocument;
      if (!document) {
        return;
      }

      const xrButton = document.getElementById("xr-button") as UIKit.Text;
      xrButton.addEventListener("click", () => {
        if (this.world.visibilityState.value === VisibilityState.NonImmersive) {
          this.world.launchXR();
        } else {
          this.world.exitXR();
        }
      });
      this.world.visibilityState.subscribe((visibilityState) => {
        if (visibilityState === VisibilityState.NonImmersive) {
          xrButton.setProperties({ text: "Enter XR" });
        } else {
          xrButton.setProperties({ text: "Exit to Browser" });
        }
      });

      // Manual "Airgap mode" override — pins the network state
      // machine to OFFLINE regardless of probe results, for facilities
      // where even probing is prohibited. Label is updated directly on
      // click rather than via networkStateMachine.subscribe(), since
      // toggling the override doesn't always change the *mode* (e.g.
      // enabling it while already offline) and that subscription only
      // fires on mode changes.
      const airgapButton = document.getElementById(
        "airgap-button",
      ) as UIKit.Text;
      const setAirgapLabel = (enabled: boolean) => {
        airgapButton.setProperties({
          text: enabled ? "Airgap Mode: On" : "Airgap Mode: Off",
        });
      };
      setAirgapLabel(networkStateMachine.isAirgapOverride());
      airgapButton.addEventListener("click", () => {
        const enabled = !networkStateMachine.isAirgapOverride();
        networkStateMachine.setAirgapOverride(enabled);
        setAirgapLabel(enabled);
      });

      // Demo/dev reset: wipe the IndexedDB findings queue (synced and
      // unsynced) + frame blobs, then refresh the HUD "N queued" banner.
      const clearQueueButton = document.getElementById(
        "clear-queue-button",
      ) as UIKit.Text;
      clearQueueButton.name = "clear-queue-button";
      clearQueueButton.addEventListener("click", () => {
        void (async () => {
          const removed = await clearQueue();
          console.info(`[panel] queue cleared — ${removed} finding(s) removed`);
          clearQueueButton.setProperties({
            text: `Cleared ${removed} finding${removed === 1 ? "" : "s"}`,
          });
          setTimeout(
            () => clearQueueButton.setProperties({ text: "Clear Queue" }),
            2000,
          );
          this.world
            .getSystem(HudSystem)
            ?.setBanner(networkStateMachine.getMode(), await getUnsyncedCount());
        })();
      });
    });
  }
}
