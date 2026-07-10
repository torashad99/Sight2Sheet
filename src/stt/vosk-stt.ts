/**
 * On-device speech-to-text via Vosk WASM.
 * Fully offline once the model is cached — no network calls.
 *
 * Two Kaldi recognizers share one Model: a grammar-constrained "command"
 * recognizer for accuracy on the fixed vocabulary, and an unconstrained
 * "free-text" recognizer that only receives audio for a short window after
 * "note" is heard, to capture the free-form dictation Vosk's grammar mode
 * can't transcribe (grammar-constrained recognition only ever emits words
 * from the grammar list, so open dictation needs the unconstrained model).
 *
 * Needs on-device verification (Quest 3 mic permission + real speech) —
 * flagged in the final verification pass.
 */
import {
  createModel,
  type Model,
  type KaldiRecognizer,
} from "vosk-browser";
import { VoiceCommand, type VoiceCommandType } from "../schema.js";
import type {
  PartialTextHandler,
  STTBackend,
  VoiceEventHandler,
} from "./stt.js";

const VOSK_MODEL_URL = "/models/vosk/vosk-model-small-en-us-0.15.tar.gz";
const SAMPLE_RATE = 16000;
const NOTE_CAPTURE_WINDOW_MS = 6000;

const SIMPLE_COMMANDS = new Set<string>([
  VoiceCommand.Confirm,
  VoiceCommand.Skip,
  VoiceCommand.Pause,
  VoiceCommand.Resume,
  VoiceCommand.Export,
  VoiceCommand.Status,
]);

function asSimpleCommand(word: string): VoiceCommandType | null {
  return SIMPLE_COMMANDS.has(word) ? (word as VoiceCommandType) : null;
}

// "[unk]" is Vosk's out-of-grammar filler token — without it, speech that
// doesn't match a grammar word is dropped rather than degrading gracefully.
const COMMAND_GRAMMAR = JSON.stringify([
  "confirm",
  "skip",
  "pause",
  "resume",
  "export",
  "status",
  "note",
  "[unk]",
]);

export class VoskSTT implements STTBackend {
  readonly kind = "vosk" as const;

  private model: Model | null = null;
  private commandRecognizer: KaldiRecognizer | null = null;
  private freeTextRecognizer: KaldiRecognizer | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micStream: MediaStream | null = null;

  private capturingNote = false;
  private noteParts: string[] = [];
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPartial = "";

  constructor(
    private readonly onEvent: VoiceEventHandler,
    private readonly onPartial?: PartialTextHandler,
  ) {}

  async start(): Promise<void> {
    this.model = await createModel(VOSK_MODEL_URL);

    this.commandRecognizer = new this.model.KaldiRecognizer(
      SAMPLE_RATE,
      COMMAND_GRAMMAR,
    );
    this.commandRecognizer.on("result", (message) => {
      if (message.event !== "result") return;
      this.lastPartial = "";
      this.handleCommandResult(message.result.text);
    });
    // Partial results stream while the user is still speaking — final
    // results wait for silence endpointing (seconds later). Surface them
    // for immediate UI acknowledgement; commands only fire on finals.
    this.commandRecognizer.on("partialresult", (message) => {
      if (message.event !== "partialresult") return;
      const partial = message.result.partial?.trim() ?? "";
      if (!partial || partial === "[unk]" || partial === this.lastPartial) {
        return;
      }
      this.lastPartial = partial;
      this.onPartial?.(partial);
    });

    this.freeTextRecognizer = new this.model.KaldiRecognizer(SAMPLE_RATE);
    this.freeTextRecognizer.on("result", (message) => {
      if (message.event !== "result") return;
      if (this.capturingNote && message.result.text.trim()) {
        this.noteParts.push(message.result.text.trim());
      }
    });

    this.micStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
      },
    });

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.micStream);
    // ScriptProcessorNode is deprecated but is what vosk-browser's own
    // README example uses and needs no separate AudioWorklet module file;
    // an AudioWorklet migration is a reasonable follow-up, not required
    // for MVP correctness.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const active = this.capturingNote
        ? this.freeTextRecognizer
        : this.commandRecognizer;
      try {
        active?.acceptWaveform(event.inputBuffer);
      } catch (err) {
        // Transient decode hiccups shouldn't kill the whole session.
        console.warn("Vosk acceptWaveform failed:", err);
      }
    };
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  private handleCommandResult(text: string): void {
    const word = text.trim().toLowerCase().split(/\s+/)[0];
    if (!word) return;

    if (word === "note") {
      this.beginNoteCapture();
      return;
    }
    const command = asSimpleCommand(word);
    if (command) {
      this.onEvent({ command });
    }
  }

  private beginNoteCapture(): void {
    this.capturingNote = true;
    this.noteParts = [];
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(
      () => this.endNoteCapture(),
      NOTE_CAPTURE_WINDOW_MS,
    );
  }

  private endNoteCapture(): void {
    this.capturingNote = false;
    this.noteTimer = null;
    const freeText = this.noteParts.join(" ").trim();
    this.noteParts = [];
    if (freeText) {
      this.onEvent({ command: VoiceCommand.Note, freeText });
    }
  }

  stop(): void {
    if (this.noteTimer) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    this.commandRecognizer?.remove();
    this.freeTextRecognizer?.remove();
    this.commandRecognizer = null;
    this.freeTextRecognizer = null;
    this.model?.terminate();
    this.model = null;
  }
}
