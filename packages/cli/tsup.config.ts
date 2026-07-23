import { defineConfig } from "tsup";
import fs from "fs-extra";
import path from "path";

export default defineConfig({
  entry: ["src/index.ts", "src/dev-banner.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false, // Easier debugging
  onSuccess: async () => {
    // Copy templates to dist
    await fs.copy(
      path.join(__dirname, "src/templates"),
      path.join(__dirname, "dist/templates"),
    );
    console.log("Copied templates to dist/templates");
  },
});
