const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const distServer = path.resolve(__dirname, "..", "dist-server");
fs.writeFileSync(path.join(distServer, "package.json"), JSON.stringify({ type: "commonjs" }));

const result = spawnSync(process.execPath, ["--test", "dist-server/**/*.test.js"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  shell: true
});

process.exit(result.status ?? 1);
