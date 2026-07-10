/// <reference types="vite/client" />

/**
 * Online-only feature credentials. All optional — absent keys
 * degrade to the offline path (rule-fallback config, Vosk-only STT, CSV
 * export without Sheets sync) rather than failing, per the user's choice to
 * stub these behind env vars for this build. See .env.example.
 */
interface ImportMetaEnv {
  readonly VITE_OPENROUTER_API_KEY?: string;
  readonly VITE_DEEPGRAM_API_KEY?: string;
  /** OAuth2 client ID (Google Identity Services) — write access to Sheets
   * needs an OAuth token, not a plain API key. */
  readonly VITE_GSHEETS_CLIENT_ID?: string;
  readonly VITE_GSHEETS_SPREADSHEET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
