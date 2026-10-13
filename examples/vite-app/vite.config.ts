import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import holt from "holt/vite";

export default defineConfig({
  // holt mounts its API at /__holt on this dev server. Settings come
  // from ./holt.config.json; plugin options would override them.
  plugins: [holt()],
  server: {
    // Bind explicitly to IPv4 loopback. "localhost" can resolve to ::1 only,
    // and the extension (and curl examples) use 127.0.0.1.
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        checkout: fileURLToPath(new URL("./checkout.html", import.meta.url)),
      },
    },
  },
});
