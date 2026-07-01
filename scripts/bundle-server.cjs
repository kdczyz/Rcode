const { build } = require("esbuild");
const path = require("path");
const fs = require("fs");

const projectRoot = path.resolve(__dirname, "..");
const outdir = path.join(projectRoot, "dist-server-bundle");

fs.mkdirSync(outdir, { recursive: true });

// Create a package.json in the bundle dir WITHOUT "type": "module"
// so that esbuild treats .js files as CJS (their actual format).
const pkgPath = path.join(outdir, "package.json");
fs.writeFileSync(pkgPath, JSON.stringify({ name: "agent-server-bundle", private: true }));

// Copy dist-server files into the bundle dir so esbuild resolves them as CJS
const distServerDir = path.join(projectRoot, "dist-server");
const bundledSrcDir = path.join(outdir, "src");
fs.cpSync(distServerDir, bundledSrcDir, { recursive: true });

const entry = path.join(bundledSrcDir, "index.js");

build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: path.join(outdir, "index.cjs"),
  external: ["electron"],
  minify: false,
  sourcemap: false,
})
  .then(() => {
    // Clean up temporary files
    fs.rmSync(bundledSrcDir, { recursive: true, force: true });
    fs.unlinkSync(pkgPath);
    console.log("Server bundle created: dist-server-bundle/index.cjs");
  })
  .catch((err) => {
    try { fs.rmSync(bundledSrcDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(pkgPath); } catch (_) {}
    console.error("Server bundle failed:", err);
    process.exit(1);
  });
