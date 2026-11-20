#!/usr/bin/env node

/**
 * Sync all workspace package versions to the release version.
 * Called by semantic-release via @semantic-release/exec prepareCmd.
 *
 * Usage: node scripts/sync-versions.js <version>
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveRepoRoot(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL("..", moduleUrl));
}

export function syncWorkspaceVersions(root, version) {
  const packagesDir = join(root, "packages");

  const rootPkgPath = join(root, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
  rootPkg.version = version;
  writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
  console.log(`  root → ${version}`);

  const entries = readdirSync(packagesDir);
  for (const entry of entries) {
    const pkgPath = join(packagesDir, entry, "package.json");
    try {
      statSync(pkgPath);
    } catch {
      continue;
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkg.version = version;

    for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[depType];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (name.startsWith("@itz4blitz/")) {
          deps[name] = version;
          console.log(`    ${pkg.name} dep ${name} → ${version}`);
        }
      }
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  ${pkg.name} → ${version}`);
  }

  console.log(`\nAll packages synced to v${version}`);
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/sync-versions.js <version>");
    process.exit(1);
  }

  const root = resolveRepoRoot(import.meta.url);
  syncWorkspaceVersions(root, version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
