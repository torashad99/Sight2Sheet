/**
 * Cached CV configs (IndexedDB `configs` store) + the offline rule-based
 * fallback mapper. This is what CONFIG_LOAD / CONFIG_FALLBACK
 * read from in the session state machine.
 */
import { getDB } from "./db.js";
import { COCO_CLASSES, DOMAIN_PROXY_MAP, guessRegexHint } from "./coco-classes.js";
import type { CVConfig } from "./schema.js";

const ACTIVE_CONFIG_META_KEY = "activeConfigId";

/**seeded so the loop is
 * demonstrable with zero prior setup. Origin "manual" (not "llm") because it
 * ships in the repo rather than coming from a pre-mission LLM call. */
// Bump whenever buildDefaultConfig() changes — getActiveConfig() refreshes a
// cached seed with an older (or missing) version in place, so seed edits
// actually reach devices that already ran the app.
const SEED_VERSION = 2;

function buildDefaultConfig(): CVConfig {
  return {
    config_id: crypto.randomUUID(),
    origin: "manual",
    seed_version: SEED_VERSION,
    task_description:
      "Check fire extinguisher pressure gauges — log the extinguisher ID and whether the gauge is in the green zone.",
    created_at: new Date().toISOString(),
    pipelines: [
      {
        type: "object_detection",
        model: "efficientdet_lite0",
        target_classes: ["fire hydrant", "bottle"],
        score_threshold: 0.45,
      },
      {
        type: "ocr",
        region: "near_detection",
        regex_hint: "^EXT-\\d{3,5}$",
      },
    ],
    log_schema: {
      // v2: dropped "gauge_status" — bottle-tag testing has no gauge
      // judgment; "notes" already carries the spoken note.
      columns: [
        "timestamp",
        "asset_id",
        "confidence",
        "notes",
        "pose_x",
        "pose_y",
        "pose_z",
        "frame_ref",
      ],
    },
  };
}

export async function saveConfig(config: CVConfig): Promise<void> {
  const db = await getDB();
  await db.put("configs", config);
}

export async function setActiveConfig(configId: string): Promise<void> {
  const db = await getDB();
  await db.put("meta", { key: ACTIVE_CONFIG_META_KEY, value: configId });
}

export async function getConfigById(id: string): Promise<CVConfig | null> {
  const db = await getDB();
  return (await db.get("configs", id)) ?? null;
}

export async function listConfigs(): Promise<CVConfig[]> {
  const db = await getDB();
  return db.getAll("configs");
}

/**
 * The single entry point CONFIG_LOAD uses. Returns the cached active
 * config, seeding the built-in default on first run so the app never opens
 * to an empty state — matches "app launches into passthrough, loads the
 * cached config".
 */
export async function getActiveConfig(): Promise<CVConfig> {
  const db = await getDB();
  const activeMeta = await db.get("meta", ACTIVE_CONFIG_META_KEY);
  if (activeMeta) {
    const config = await db.get("configs", activeMeta.value);
    if (config) return migrateSeededConfig(config);
  }
  const seeded = buildDefaultConfig();
  await saveConfig(seeded);
  await setActiveConfig(seeded.config_id);
  return seeded;
}

/**
 * Refreshes a cached built-in seed from an older app build (identified by
 * origin "manual" — only the seed creates those — with a stale/missing
 * seed_version). Keeps config_id/created_at so existing findings' config_id
 * references stay valid. LLM/fallback configs are never touched.
 */
async function migrateSeededConfig(config: CVConfig): Promise<CVConfig> {
  if (config.origin !== "manual") return config;
  if ((config.seed_version ?? 1) >= SEED_VERSION) return config;
  const migrated: CVConfig = {
    ...buildDefaultConfig(),
    config_id: config.config_id,
    created_at: config.created_at,
  };
  await saveConfig(migrated);
  console.info(
    `[config] refreshed built-in seed to v${SEED_VERSION} (was v${config.seed_version ?? 1})`,
  );
  return migrated;
}

/**
 * Offline keyword fallback: "if the inspector must define a new
 * task while already in the gap." Deliberately crude — matches literal COCO
 * class names and known domain-term proxies in the free-text description, plus a best-guess
 * asset-ID regex. Always produces *some* usable config, never throws.
 */
export function mapTaskDescriptionToConfig(taskDescription: string): CVConfig {
  const text = taskDescription.toLowerCase();
  const classes = new Set<string>();

  for (const cocoClass of COCO_CLASSES) {
    if (text.includes(cocoClass.toLowerCase())) {
      classes.add(cocoClass);
    }
  }
  for (const { pattern, classes: proxyClasses } of DOMAIN_PROXY_MAP) {
    if (pattern.test(taskDescription)) {
      for (const c of proxyClasses) classes.add(c);
    }
  }
  // Last resort so the pipeline always has something to look for.
  if (classes.size === 0) {
    classes.add("bottle");
    classes.add("cup");
    classes.add("chair");
  }

  const regexHint = guessRegexHint(taskDescription);

  return {
    config_id: crypto.randomUUID(),
    origin: "rule_fallback",
    task_description: taskDescription,
    created_at: new Date().toISOString(),
    pipelines: [
      {
        type: "object_detection",
        model: "efficientdet_lite0",
        target_classes: Array.from(classes),
        score_threshold: 0.45,
      },
      {
        type: "ocr",
        region: "near_detection",
        ...(regexHint ? { regex_hint: regexHint } : {}),
      },
    ],
    log_schema: {
      columns: [
        "timestamp",
        "asset_id",
        "detection_class",
        "confidence",
        "notes",
        "pose_x",
        "pose_y",
        "pose_z",
        "frame_ref",
      ],
    },
  };
}

/** build a rule-based config from free text, cache it,
 * and make it active. */
export async function createFallbackConfig(
  taskDescription: string,
): Promise<CVConfig> {
  const config = mapTaskDescriptionToConfig(taskDescription);
  await saveConfig(config);
  await setActiveConfig(config.config_id);
  return config;
}
