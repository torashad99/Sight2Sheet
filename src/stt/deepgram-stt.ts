/**
 * Deepgram streaming STT — ONLINE-only dictation upgrade.
 * Never called in the gap; the router (stt.ts) only picks this backend when
 * `networkMode === "online"` and VITE_DEEPGRAM_API_KEY is set. Stubbed
 * behind that env var per the user's choice to defer real credentials —
 * the code path is complete and will work once a key is supplied, but
 * without one `createSTTBackend` never selects it and Vosk handles the loop.
 */
import type { VoiceCommandType } from "../schema.js";
import { VoiceCommand } from "../schema.js";
import type { STTBackend, VoiceEventHandler } from "./stt.js";

const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16&sample_rate=16000";

const SIMPLE_COMMANDS = new Set<string>([
  VoiceCommand.Confirm,
  VoiceCommand.Skip,
  VoiceCommand.Pause,
  VoiceCommand.Resume,
  VoiceCommand.Export,
  VoiceCommand.Status,
]);

export class DeepgramSTT implements STTBackend {
  readonly kind = "deepgram" as const;

  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micStream: MediaStream | null = null;

  constructor(private readonly onEvent: VoiceEventHandler) {}

  async start(): Promise<void> {
    const apiKey = import.meta.env.VITE_DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error("VITE_DEEPGRAM_API_KEY is not set");
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });

    this.socket = new WebSocket(DEEPGRAM_WS_URL, ["token", apiKey]);
    this.socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error("socket not created"));
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("Deepgram socket failed to open")),
        { once: true },
      );
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.micStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = floatTo16BitPCM(input);
      this.socket.send(pcm16);
    };
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: {
      channel?: { alternatives?: Array<{ transcript?: string }> };
      is_final?: boolean;
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed.is_final) return;

    const transcript = parsed.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    const [first, ...rest] = transcript.toLowerCase().split(/\s+/);
    if (first === "note") {
      const freeText = rest.join(" ").trim();
      if (freeText) this.onEvent({ command: VoiceCommand.Note, freeText });
      return;
    }
    if (SIMPLE_COMMANDS.has(first)) {
      this.onEvent({ command: first as VoiceCommandType });
    }
  }

  stop(): void {
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
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
