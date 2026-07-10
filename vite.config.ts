import { iwsdkDev } from "@iwsdk/vite-plugin-dev";

import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    mkcert(),
    iwsdkDev({
      emulator: {
        device: "metaQuest3",

        environment: "living_room",
      },
      ai: { mode: "agent" },
      verbose: true,
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),

    // Airgap-first PWA precache: the app shell + CV/STT wasm + models must all be
    // Service-Worker-cached from the one online pre-mission visit so the
    // Quest browser can cold-launch the PWA in airplane mode.
    VitePWA({
      registerType: "autoUpdate",
      // Active during `npm run dev` / `iwsdk dev up` too, not just a
      // production build — lets the airplane-mode cold-launch gate be rehearsed against the dev server.
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "Sight2Sheet",
        short_name: "Sight2Sheet",
        description:
          "Air-gapped mixed-reality inspection assistant — on-device CV, voice confirm, offline logging.",
        start_url: "./",
        display: "standalone",
        background_color: "#09090b",
        theme_color: "#09090b",
      },
      workbox: {
        // Vosk model tar.gz (~41MB) is the largest single precached file;
        // give real headroom above it. Everything the offline CV/STT loop
        // needs (app bundle + wasm + models, including the .tar.gz Vosk
        // model — "*.gz" matches "*.tar.gz" by suffix) is precached
        // up-front rather than left to a lazy runtime fetch, so it's
        // guaranteed cached after the one online pre-mission visit even if
        // the inspector never triggers STT before going offline.
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,json,wasm,tflite,gz}"],
      },
    }),
  ],
  server: { host: "0.0.0.0", port: 8081, open: true },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: "./",
});
