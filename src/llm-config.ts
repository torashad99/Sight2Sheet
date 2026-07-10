/**
 * Pre-mission NL → CV Config via OpenRouter.
 * ONLINE-only, by construction — the gap never calls this. Stubbed behind
 * VITE_OPENROUTER_API_KEY per the user's choice; without a key,
 * `generateConfigFromLLM` resolves to null and session.ts falls through to
 * the offline rule mapper (config-store.ts's `createFallbackConfig`).
 */
import { COCO_CLASSES } from "./coco-classes.js";
import { saveConfig, setActiveConfig } from "./config-store.js";
import { isCVConfig, type CVConfig } from "./schema.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Update if the org standardizes on a different OpenRouter model slug.
const MODEL = "anthropic/claude-3.5-sonnet";

const SYSTEM_PROMPT = `You configure an on-device computer-vision inspection pipeline for a field inspector wearing a mixed-reality headset. The only available detector is EfficientDet-Lite0, trained on the 80 COCO classes, plus an OCR pass for reading labels/asset IDs. Domain terms in the inspector's request (e.g. "fire extinguisher", "pressure gauge", "hard hat") are usually NOT COCO classes — pick the closest visually-similar COCO proxy class(es) instead, and rely on OCR + a regex_hint to capture printed asset IDs.

Available COCO classes: ${COCO_CLASSES.join(", ")}

Respond with ONLY a JSON object (no prose, no markdown fences) of this exact shape:
{
  "pipelines": [
    { "type": "object_detection", "model": "efficientdet_lite0", "target_classes": ["<one or more COCO class names from the list above>"], "score_threshold": <number 0-1, typically 0.4-0.6> },
    { "type": "ocr", "region": "near_detection", "regex_hint": "<optional regex string matching the asset-ID format implied by the request, e.g. ^EXT-\\\\d{3,5}$ — omit the field entirely if no ID pattern is implied>" }
  ],
  "log_schema": { "columns": ["timestamp", "asset_id", "<other relevant columns implied by the request>", "confidence", "notes", "pose_x", "pose_y", "pose_z", "frame_ref"] }
}`;

function isLlmConfigured(): boolean {
  return Boolean(import.meta.env.VITE_OPENROUTER_API_KEY);
}

interface LLMPipelinesResponse {
  pipelines: CVConfig["pipelines"];
  log_schema: CVConfig["log_schema"];
}

/** Returns null (never throws) if unconfigured, offline, or the call/parse
 * fails — callers should treat null as "fall back to the rule mapper". */
export async function generateConfigFromLLM(
  taskDescription: string,
): Promise<CVConfig | null> {
  if (!isLlmConfigured()) return null;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": window.location.origin,
        "X-Title": "Sight2Sheet",
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: taskDescription },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty LLM response content");

    const parsed = JSON.parse(content) as LLMPipelinesResponse;
    const config: CVConfig = {
      config_id: crypto.randomUUID(),
      origin: "llm",
      task_description: taskDescription,
      created_at: new Date().toISOString(),
      pipelines: parsed.pipelines,
      log_schema: parsed.log_schema,
    };

    if (!isCVConfig(config)) {
      throw new Error("LLM response failed CV Config schema validation");
    }
    return config;
  } catch (err) {
    console.error("LLM config generation failed:", err);
    return null;
  }
}

/** generate, cache, and activate a config from free text.
 * Returns null on failure so the caller can fall through to CONFIG_FALLBACK. */
export async function createLLMConfig(
  taskDescription: string,
): Promise<CVConfig | null> {
  const config = await generateConfigFromLLM(taskDescription);
  if (!config) return null;
  await saveConfig(config);
  await setActiveConfig(config.config_id);
  return config;
}
