#!/usr/bin/env node
/**
 * Windows Portable Packager for Session Manager (Issue #24)
 *
 * Stages:
 *   - Compiled workspace packages (@sm/shared, @sm/store, @sm/adapters, @sm/core)
 *   - Compiled CLI entrypoint (@sm/cli -> apps/cli/dist/index.js)
 *   - Required runtime dependencies (e.g., fzstd)
 *   - Flutter Windows desktop source / release bundle (apps/ui_win)
 *   - Windows launcher scripts (sm.cmd, sm-ui.cmd)
 *   - portable-manifest.json
 *
 * Usage:
 *   node scripts/build-win-portable.mjs [--out dist/win-portable] [--skip-build]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let outDir = path.join(REPO_ROOT, 'dist', 'win-portable');
  let skipBuild = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg === '--skip-build') {
      skipBuild = true;
    }
  }
  return { outDir, skipBuild };
}

function copyDirClean(src, dest, excludeDirs = new Set()) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeDirs.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, destPath, excludeDirs);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function stageWorkspacePackage(pkgRelDir, destDir) {
  const srcRoot = path.join(REPO_ROOT, pkgRelDir);
  const pkgJsonPath = path.join(srcRoot, 'package.json');
  const distDir = path.join(srcRoot, 'dist');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Missing package.json in ${pkgRelDir}`);
  }
  if (!fs.existsSync(distDir)) {
    throw new Error(`Missing compiled dist/ in ${pkgRelDir}. Run "npx tsc --build" first.`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(pkgJsonPath, path.join(destDir, 'package.json'));
  copyDirClean(distDir, path.join(destDir, 'dist'));
}

function main() {
  const { outDir, skipBuild } = parseArgs(process.argv.slice(2));

  if (!skipBuild) {
    console.log('[package:win] Building TypeScript workspace via npx tsc --build...');
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const runtimeDir = path.join(outDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Stage workspace packages & CLI under runtime/node_modules/@sm/* and runtime/apps/cli
  const workspacePackages = [
    { rel: 'packages/shared', scopeName: 'shared' },
    { rel: 'packages/store', scopeName: 'store' },
    { rel: 'packages/adapters', scopeName: 'adapters' },
    { rel: 'packages/core', scopeName: 'core' },
  ];

  const smNodeModulesDir = path.join(runtimeDir, 'node_modules', '@sm');
  for (const pkg of workspacePackages) {
    stageWorkspacePackage(pkg.rel, path.join(smNodeModulesDir, pkg.scopeName));
  }

  const cliDestDir = path.join(runtimeDir, 'apps', 'cli');
  stageWorkspacePackage('apps/cli', cliDestDir);

  // Stage third-party runtime dependency (fzstd) if installed in root or adapters node_modules
  const fzstdCandidates = [
    path.join(REPO_ROOT, 'node_modules', 'fzstd'),
    path.join(REPO_ROOT, 'packages', 'shared', 'node_modules', 'fzstd'),
    path.join(REPO_ROOT, 'packages', 'adapters', 'node_modules', 'fzstd'),
  ];
  const fzstdSrc = fzstdCandidates.find((p) => fs.existsSync(p));
  if (fzstdSrc) {
    copyDirClean(fzstdSrc, path.join(runtimeDir, 'node_modules', 'fzstd'));
  }

  // Stage Flutter Windows app (compiled Release bundle if present, else source + pubspec)
  const uiWinSrc = path.join(REPO_ROOT, 'apps', 'ui_win');
  const releaseRunner = path.join(uiWinSrc, 'build', 'windows', 'x64', 'runner', 'Release');
  const uiOutDir = path.join(outDir, 'ui_win');
  let uiMode = 'flutter-source';
  let releaseExeName = 'sm_ui_win.exe';
  if (fs.existsSync(releaseRunner)) {
    copyDirClean(releaseRunner, uiOutDir);
    uiMode = 'windows-release-binary';
    if (!fs.existsSync(path.join(releaseRunner, 'sm_ui_win.exe')) && fs.existsSync(path.join(releaseRunner, 'ui_win.exe'))) {
      releaseExeName = 'ui_win.exe';
    }
  } else {
    copyDirClean(uiWinSrc, uiOutDir, new Set(['.dart_tool', 'build', '.git']));
  }

  // Write portable Windows launchers (zero resident daemon!)
  const smCmdContent = [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'node "%ROOT%runtime\\apps\\cli\\dist\\index.js" %*',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, 'sm.cmd'), smCmdContent, 'utf8');

  const smUiCmdContent =
    uiMode === 'windows-release-binary'
      ? [
          '@echo off',
          'setlocal',
          'set "ROOT=%~dp0"',
          'set "SM_CLI_BIN=%ROOT%runtime\\apps\\cli\\dist\\index.js"',
          'if "%SM_ARCHIVE_DIR%"=="" set "SM_ARCHIVE_DIR=%ROOT%archive"',
          `start "" "%ROOT%ui_win\\${releaseExeName}"`,
          '',
        ].join('\r\n')
      : [
          '@echo off',
          'setlocal',
          'set "ROOT=%~dp0"',
          'set "SM_CLI_BIN=%ROOT%runtime\\apps\\cli\\dist\\index.js"',
          'if "%SM_ARCHIVE_DIR%"=="" set "SM_ARCHIVE_DIR=%ROOT%archive"',
          'pushd "%ROOT%ui_win"',
          'flutter run -d windows --dart-define=SM_ARCHIVE_DIR="%SM_ARCHIVE_DIR%" --dart-define=SM_CLI_BIN="%SM_CLI_BIN%"',
          'popd',
          '',
        ].join('\r\n');
  fs.writeFileSync(path.join(outDir, 'sm-ui.cmd'), smUiCmdContent, 'utf8');

  const manifest = {
    schema_version: '1.0',
    architecture: 'cqrs-hybrid-direct',
    resident_daemon: false,
    built_at: new Date().toISOString(),
    ui_mode: uiMode,
    cli_entrypoint: 'runtime/apps/cli/dist/index.js',
    launchers: ['sm.cmd', 'sm-ui.cmd'],
    staged_packages: workspacePackages.map((p) => `@sm/${p.scopeName}`).concat(['@sm/cli']),
    fzstd_bundled: Boolean(fzstdSrc),
  };
  fs.writeFileSync(path.join(outDir, 'portable-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[package:win] Portable bundle staged at: ${outDir} (ui_mode=${uiMode})`);
}

main();
