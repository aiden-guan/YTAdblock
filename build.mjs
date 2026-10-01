import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const isWatch = process.argv.includes("--watch");

// Ensure target directories exist
const distDir = path.resolve("dist");
const distPopupDir = path.join(distDir, "popup");
const distRulesDir = path.join(distDir, "rules");

function ensureDirs() {
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(distPopupDir, { recursive: true });
  fs.mkdirSync(distRulesDir, { recursive: true });
}

function copyStaticFiles() {
  ensureDirs();
  fs.copyFileSync("manifest.json", path.join(distDir, "manifest.json"));
  fs.copyFileSync(
    path.join("src", "styles", "cosmetic.css"),
    path.join(distDir, "cosmetic.css")
  );
  fs.copyFileSync(
    path.join("src", "rules", "youtube.json"),
    path.join(distRulesDir, "youtube.json")
  );
  fs.copyFileSync(
    path.join("src", "popup", "popup.html"),
    path.join(distPopupDir, "index.html")
  );
  fs.copyFileSync(
    path.join("src", "popup", "popup.css"),
    path.join(distPopupDir, "popup.css")
  );
}

const buildOptions = [
  // 1. MAIN world script (IIFE for isolated execution in page context)
  {
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main-world.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false
  },
  // 2. ISOLATED world bridge script
  {
    entryPoints: ["src/content/bridge.ts"],
    outfile: "dist/bridge.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false
  },
  // 3. ISOLATED world fallback coordinator script
  {
    entryPoints: ["src/content/fallback.ts"],
    outfile: "dist/fallback.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false
  },
  // 4. Background service worker (ESM)
  {
    entryPoints: ["src/background/index.ts"],
    outfile: "dist/background.js",
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false
  },
  // 5. Popup logic (IIFE)
  {
    entryPoints: ["src/popup/popup.ts"],
    outfile: "dist/popup/popup.js",
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false
  }
];

async function run() {
  copyStaticFiles();

  if (isWatch) {
    console.log("Starting build in watch mode...");
    const contexts = await Promise.all(
      buildOptions.map((opts) => esbuild.context(opts))
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all(buildOptions.map((opts) => esbuild.build(opts)));
    console.log("Build complete! Output generated in dist/");
  }
}

run().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
