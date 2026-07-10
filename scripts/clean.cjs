const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

const generatedPaths = [
  "build",
  "dist",
  "dist-server",
  "dist-server-bundle",
  "release"
];

function removePath(relativePath) {
  const target = path.join(projectRoot, relativePath);
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`removed ${relativePath}`);
}

function removeDsStoreFiles(current) {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name === ".DS_Store") {
      fs.rmSync(fullPath, { force: true });
      console.log(`removed ${path.relative(projectRoot, fullPath)}`);
    } else if (entry.isDirectory()) {
      removeDsStoreFiles(fullPath);
    }
  }
}

for (const relativePath of generatedPaths) {
  removePath(relativePath);
}

removeDsStoreFiles(projectRoot);
