/**
 * Single shared IndexedDB database for Sight2Sheet: cached CV configs
 * (config-store.ts) and the offline findings queue (log/queue.ts) both live
 * here so there's one upgrade path and one `storage.persist()` call.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CVConfig, FindingRecord } from "./schema.js";

interface Sight2SheetDB extends DBSchema {
  configs: {
    key: string; // config_id
    value: CVConfig;
  };
  meta: {
    key: string;
    value: { key: string; value: string };
  };
  findings: {
    key: string; // id
    value: FindingRecord;
    indexes: { "by-session": string };
  };
  frames: {
    key: string; // frame_ref
    value: Blob;
  };
}

const DB_NAME = "sight2sheet";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<Sight2SheetDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<Sight2SheetDB>> {
  if (!dbPromise) {
    dbPromise = openDB<Sight2SheetDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("configs")) {
          db.createObjectStore("configs", { keyPath: "config_id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("findings")) {
          const findings = db.createObjectStore("findings", {
            keyPath: "id",
          });
          // `synced` is a boolean, which IndexedDB can't use as an index key,
          // so unsynced lookups filter a getAll() in JS (log/queue.ts) —
          // fine at this scale.
          findings.createIndex("by-session", "session_id");
        }
        if (!db.objectStoreNames.contains("frames")) {
          db.createObjectStore("frames");
        }
      },
    });
  }
  return dbPromise;
}

/** Best-effort request to keep Cache Storage / IndexedDB from being evicted
 * under storage pressure. Safe to call multiple times;
 * no-ops where unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
