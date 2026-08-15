const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createInstallTargetAdapter,
  createManagedOperation,
  listRelativeFiles,
  normalizeRelativePath,
} = require('./helpers');

/**
 * DeepSeek Harness home adapter.
 *
 * ECC's source surface is `.dsh/agent-presets/ecc` plus `.dsh/skills`. The
 * harness home expects those children at `$DSH_HOME/.agent-presets/ecc` and
 * `$DSH_HOME/skills`, so this adapter strips the leading `.dsh/` segment and
 * does NOT copy `.dsh/README.md` (which is repository documentation, not a
 * runtime file).
 */

const MANAGED_DSH_DIRECTORIES = Object.freeze([
  'agent-presets/ecc',
  'skills',
]);

function stripDshPrefix(sourceRelativePath) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  if (normalized.startsWith('.dsh/')) {
    return normalized.slice('.dsh/'.length);
  }
  return normalized;
}

function planDshOperations(input, adapter) {
  const modules = Array.isArray(input.modules) ? input.modules : [];
  const repoRoot = input.repoRoot;
  const operations = [];

  for (const module of modules) {
    for (const modulePath of module.paths || []) {
      const normalizedPath = normalizeRelativePath(modulePath);
      if (normalizedPath !== '.dsh' && !normalizedPath.startsWith('.dsh/')) {
        continue;
      }

      const sourceDir = path.join(repoRoot, normalizedPath);
      const relativeFiles = fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory()
        ? listRelativeFiles(sourceDir)
        : [];

      for (const relativeFile of relativeFiles) {
        const sourceRelativePath = path.join(normalizedPath, relativeFile);
        const installedRelativePath = stripDshPrefix(sourceRelativePath);
        if (!MANAGED_DSH_DIRECTORIES.some(prefix => (
          normalizeRelativePath(installedRelativePath).startsWith(prefix)
        ))) {
          continue;
        }

        operations.push(createManagedOperation({
          moduleId: module.id,
          sourceRelativePath,
          destinationPath: path.join(adapter.resolveRoot(input), installedRelativePath),
          strategy: 'preserve-relative-path',
        }));
      }
    }
  }

  return operations;
}

module.exports = createInstallTargetAdapter({
  id: 'dsh-home',
  target: 'dsh',
  kind: 'home',
  rootSegments: ['.dsh'],
  installStatePathSegments: ['ecc-install-state.json'],
  nativeRootRelativePath: null,
  resolveRoot(input = {}) {
    const homeBase = process.env.DSH_HOME || path.join(input.homeDir || os.homedir(), '.dsh');
    return path.resolve(homeBase);
  },
  planOperations: planDshOperations,
});
