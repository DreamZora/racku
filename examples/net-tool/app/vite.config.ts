import { quasar, transformAssetUrls } from "@quasar/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The Tauri shell loads the page from this exact origin in development, and the rack's ui
// device allows it; so the port is fixed.
export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls } }), quasar()],
  clearScreen: false,
  server: { host: "localhost", port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
