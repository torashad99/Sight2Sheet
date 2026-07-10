/**
 * STT interface + router.
 *
 * Backend selection: Vosk is the offline-capable default. Deepgram is only
 * ever chosen while ONLINE and configured (an online-mode dictation
 * upgrade — never required for the airgap loop). If Vosk itself fails to
 * initialize, the router falls back to
 * a buttons-only backend — this is *not* the same as choosing "buttons" on
 * purpose; controller A/B confirm/skip stays wired independently of STT
 * (session.ts), so losing voice never loses the ability to log findings.
 */
import type { NetworkMode, VoiceCommandType } from "../schema.js";

export interface VoiceEvent {
  command: VoiceCommandType;
  freeText?: string;
}

export type VoiceEventHandler = (event: VoiceEvent) => void;

/** Streaming partial-recognition text — fires while the user is still
 * speaking, well before the final (endpointed) result. UI-feedback only;
 * never dispatch commands from partials. */
export type PartialTextHandler = (text: string) => void;

export type STTBackendKind = "vosk" | "deepgram" | "buttons";

export interface STTBackend {
  readonly kind: STTBackendKind;
  start(): Promise<void>;
  /** Full teardown: stops audio capture, releases the mic stream, frees the
   * Vosk model/recognizers or Deepgram socket. */
  stop(): void;
}

function isDeepgramConfigured(): boolean {
  return Boolean(import.meta.env.VITE_DEEPGRAM_API_KEY);
}

function createButtonsOnlyBackend(): STTBackend {
  return {
    kind: "buttons",
    async start() {
      /* no-op — controller confirm/skip is handled directly in session.ts */
    },
    stop() {
      /* no-op */
    },
  };
}

export async function createSTTBackend(
  networkMode: NetworkMode,
  onEvent: VoiceEventHandler,
  onPartial?: PartialTextHandler,
): Promise<STTBackend> {
  if (networkMode === "online" && isDeepgramConfigured()) {
    try {
      const { DeepgramSTT } = await import("./deepgram-stt.js");
      const backend = new DeepgramSTT(onEvent);
      await backend.start();
      return backend;
    } catch (err) {
      console.error(
        "Deepgram STT failed to start, falling back to Vosk:",
        err,
      );
    }
  }

  try {
    const { VoskSTT } = await import("./vosk-stt.js");
    const backend = new VoskSTT(onEvent, onPartial);
    await backend.start();
    return backend;
  } catch (err) {
    console.error(
      "Vosk STT failed to initialize — falling back to controller-button-only input:",
      err,
    );
    return createButtonsOnlyBackend();
  }
}
