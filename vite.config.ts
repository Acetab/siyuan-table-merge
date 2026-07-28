import {defineConfig} from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        exports: "named",
      },
    },
    sourcemap: false,
    minify: false,
  },
});
