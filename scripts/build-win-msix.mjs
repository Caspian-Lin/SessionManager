#!/usr/bin/env node
/**
 * Windows MSIX Installer Builder & Signer for Session Manager (Issue #32)
 *
 * Stages:
 *   - Compiled Flutter Windows Release bundle (sm_ui_win.exe, flutter_windows.dll, sqlite3.dll, data/)
 *   - Read-only CLI runtime under runtime/ (node.exe, @sm/* workspace dist, fzstd, apps/cli/dist)
 *   - MSIX Visual Assets generated from Runner app_icon.ico + AppxManifest.xml + resources.pri
 *   - Self-signed Code Signing certificate + signtool SHA-256 signature
 *
 * Usage:
 *   node scripts/build-win-msix.mjs [--out dist/SessionManager_0.1.0.0_x64.msix] [--skip-build] [--install]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let version = '0.1.0.0';
  let publisher = 'CN=SessionManagerDev';
  let outPath = '';
  let certPath = path.join(REPO_ROOT, 'dist', 'msix-cert', 'SessionManagerDev.pfx');
  let certPassword = 'session-manager-dev';
  let skipBuild = false;
  let install = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      outPath = path.resolve(argv[++i]);
    } else if (arg === '--version' && argv[i + 1]) {
      version = argv[++i];
    } else if (arg === '--publisher' && argv[i + 1]) {
      publisher = argv[++i];
    } else if (arg === '--cert' && argv[i + 1]) {
      certPath = path.resolve(argv[++i]);
    } else if (arg === '--cert-password' && argv[i + 1]) {
      certPassword = argv[++i];
    } else if (arg === '--skip-build') {
      skipBuild = true;
    } else if (arg === '--install') {
      install = true;
    }
  }

  if (!outPath) {
    outPath = path.join(REPO_ROOT, 'dist', `SessionManager_${version}_x64.msix`);
  }
  return { version, publisher, outPath, certPath, certPassword, skipBuild, install };
}

function findWindowsSdkTools() {
  const kitsBin = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kitsBin)) {
    throw new Error(`Windows 10/11 SDK not found at ${kitsBin}. Install Windows SDK App Certification/Packaging tools.`);
  }
  const versions = fs
    .readdirSync(kitsBin, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^10\.0\./.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();

  for (const ver of versions) {
    const x64Dir = path.join(kitsBin, ver, 'x64');
    const makeappx = path.join(x64Dir, 'makeappx.exe');
    const makepri = path.join(x64Dir, 'makepri.exe');
    const signtool = path.join(x64Dir, 'signtool.exe');
    if (fs.existsSync(makeappx) && fs.existsSync(makepri) && fs.existsSync(signtool)) {
      return { sdkVersion: ver, makeappx, makepri, signtool };
    }
  }
  throw new Error(`Could not locate makeappx.exe, makepri.exe, signtool.exe under ${kitsBin}\\10.0.*\\x64`);
}

function copyDirClean(src, dest, excludeDirs = new Set()) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeDirs.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory())) {
      copyDirClean(srcPath, destPath, excludeDirs);
    } else if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(srcPath).isFile())) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function stageWorkspacePackage(pkgRelDir, destDir) {
  const srcRoot = path.join(REPO_ROOT, pkgRelDir);
  const pkgJsonPath = path.join(srcRoot, 'package.json');
  const distDir = path.join(srcRoot, 'dist');
  if (!fs.existsSync(pkgJsonPath) || !fs.existsSync(distDir)) {
    throw new Error(`Missing built files in ${pkgRelDir}. Run pnpm -r build first.`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(pkgJsonPath, path.join(destDir, 'package.json'));
  copyDirClean(distDir, path.join(destDir, 'dist'));
}

function generateMsixAssets(icoPath, assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const psScript = `
Add-Type -AssemblyName System.Drawing
$iconPath = '${icoPath.replace(/'/g, "''")}'
$outDir = '${assetsDir.replace(/'/g, "''")}'
$icon = New-Object System.Drawing.Icon($iconPath, 256, 256)
$srcBmp = $icon.ToBitmap()

function Save-CenteredPng([int]$w, [int]$h, [int]$iconDim, [string]$fileName) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $x = [int](($w - $iconDim) / 2)
  $y = [int](($h - $iconDim) / 2)
  $g.DrawImage($srcBmp, $x, $y, $iconDim, $iconDim)
  $g.Dispose()
  $bmp.Save((Join-Path $outDir $fileName), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Save-CenteredPng 50 50 44 'StoreLogo.png'
Save-CenteredPng 44 44 38 'Square44x44Logo.png'
Save-CenteredPng 44 44 38 'Square44x44Logo.targetsize-44_altform-unplated.png'
Save-CenteredPng 150 150 112 'Square150x150Logo.png'
Save-CenteredPng 310 150 112 'Wide310x150Logo.png'

$srcBmp.Dispose()
$icon.Dispose()
`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });
}

function writeAppxManifest(stageDir, { version, publisher }) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity
    Name="CaspianLin.SessionManager"
    Publisher="${publisher}"
    Version="${version}"
    ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Session Manager</DisplayName>
    <PublisherDisplayName>SessionManager Dev</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="zh-cn" />
  </Resources>
  <Applications>
    <Application
      Id="SessionManager"
      Executable="sm_ui_win.exe"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Session Manager"
        Description="Local AI conversation archive with polymorphic adapters, lossless SQLite FTS5 search, and shareable export."
        BackgroundColor="#1A73E8"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
  fs.writeFileSync(path.join(stageDir, 'AppxManifest.xml'), xml, 'utf8');
}

function ensureSelfSignedCert(certPath, certPassword, publisher) {
  const cerPath = certPath.replace(/\.pfx$/i, '.cer');
  if (fs.existsSync(certPath) && fs.existsSync(cerPath)) {
    return { pfxPath: certPath, cerPath };
  }
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  const psScript = `
$pwdSec = ConvertTo-SecureString -String '${certPassword.replace(/'/g, "''")}' -Force -AsPlainText
$cert = New-SelfSignedCertificate \`
  -Type Custom \`
  -Subject '${publisher.replace(/'/g, "''")}' \`
  -KeyUsage DigitalSignature \`
  -FriendlyName 'SessionManager MSIX Dev Cert' \`
  -CertStoreLocation 'Cert:\\CurrentUser\\My' \`
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
Export-PfxCertificate -Cert $cert -FilePath '${certPath.replace(/'/g, "''")}' -Password $pwdSec | Out-Null
Export-Certificate -Cert $cert -FilePath '${cerPath.replace(/'/g, "''")}' | Out-Null
`;
  console.log(`[package:msix] Generating self-signed Code Signing cert for ${publisher}...`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });
  return { pfxPath: certPath, cerPath };
}

function installMsixLocally(msixPath, cerPath, version) {
  const psScript = `
$cer = '${cerPath.replace(/'/g, "''")}'
$msix = '${msixPath.replace(/'/g, "''")}'
$targetVer = '${version.replace(/'/g, "''")}'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' | Out-Null
} else {
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\CurrentUser\\TrustedPeople' | Out-Null
}
$existing = Get-AppxPackage -Name 'CaspianLin.SessionManager' -ErrorAction SilentlyContinue
if ($existing -and ($existing.Version -eq $targetVer)) {
  Write-Host "[package:msix] Removing existing dev package v$targetVer before reinstall..."
  $existing | Remove-AppxPackage
}
Add-AppxPackage -Path $msix -ForceApplicationShutdown -ForceUpdateFromAnyVersion
`;
  console.log('[package:msix] Importing certificate and installing MSIX locally...');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows MSIX packaging requires Windows.');
  }
  const opts = parseArgs(process.argv.slice(2));
  const sdk = findWindowsSdkTools();
  console.log(`[package:msix] Using Windows SDK ${sdk.sdkVersion}`);

  const uiWinDir = path.join(REPO_ROOT, 'apps', 'ui_win');
  if (!opts.skipBuild) {
    console.log('[package:msix] Building TypeScript packages and CLI...');
    execFileSync('pnpm.cmd', ['-r', '--filter', './packages/*', '--filter', './apps/*', 'run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true,
    });
    console.log('[package:msix] Building Flutter Windows Release...');
    execFileSync('flutter.bat', ['build', 'windows', '--release'], {
      cwd: uiWinDir,
      stdio: 'inherit',
      shell: true,
    });
  }

  const releaseRunner = path.join(uiWinDir, 'build', 'windows', 'x64', 'runner', 'Release');
  if (!fs.existsSync(path.join(releaseRunner, 'sm_ui_win.exe'))) {
    throw new Error(`Missing Flutter Windows release executable at ${releaseRunner}\\sm_ui_win.exe`);
  }

  const stageDir = path.join(REPO_ROOT, 'build', 'msix-stage');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 1. Copy Flutter Release binaries & sqlite3.dll directly to package root
  copyDirClean(releaseRunner, stageDir);

  // 2. Stage self-contained read-only Node + @sm/cli runtime under runtime/
  const runtimeDir = path.join(stageDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));

  const workspacePackages = [
    { rel: 'packages/shared', scopeName: 'shared' },
    { rel: 'packages/store', scopeName: 'store' },
    { rel: 'packages/adapters', scopeName: 'adapters' },
    { rel: 'packages/core', scopeName: 'core' },
  ];
  for (const pkg of workspacePackages) {
    stageWorkspacePackage(pkg.rel, path.join(runtimeDir, 'node_modules', '@sm', pkg.scopeName));
  }
  stageWorkspacePackage('apps/cli', path.join(runtimeDir, 'apps', 'cli'));

  const fzstdCandidates = [
    path.join(REPO_ROOT, 'node_modules', 'fzstd'),
    path.join(REPO_ROOT, 'packages', 'shared', 'node_modules', 'fzstd'),
    path.join(REPO_ROOT, 'packages', 'adapters', 'node_modules', 'fzstd'),
  ];
  const fzstdSrc = fzstdCandidates.find((p) => fs.existsSync(p));
  if (fzstdSrc) {
    copyDirClean(fzstdSrc, path.join(runtimeDir, 'node_modules', 'fzstd'));
  }

  // 3. Visual assets + AppxManifest.xml + resources.pri
  const icoPath = path.join(uiWinDir, 'windows', 'runner', 'resources', 'app_icon.ico');
  generateMsixAssets(icoPath, path.join(stageDir, 'Assets'));
  writeAppxManifest(stageDir, { version: opts.version, publisher: opts.publisher });

  const priConfigPath = path.join(REPO_ROOT, 'build', 'msix-priconfig.xml');
  fs.mkdirSync(path.dirname(priConfigPath), { recursive: true });
  execFileSync(sdk.makepri, ['createconfig', '/cf', priConfigPath, '/dq', 'en-US', '/o'], {
    stdio: 'inherit',
  });
  execFileSync(
    sdk.makepri,
    [
      'new',
      '/pr',
      stageDir,
      '/cf',
      priConfigPath,
      '/mn',
      path.join(stageDir, 'AppxManifest.xml'),
      '/of',
      path.join(stageDir, 'resources.pri'),
      '/o',
    ],
    { stdio: 'inherit' }
  );

  // 4. Pack .msix and sign with self-signed certificate
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  execFileSync(sdk.makeappx, ['pack', '/d', stageDir, '/p', opts.outPath, '/o'], {
    stdio: 'inherit',
  });

  const { pfxPath, cerPath } = ensureSelfSignedCert(opts.certPath, opts.certPassword, opts.publisher);
  execFileSync(
    sdk.signtool,
    ['sign', '/fd', 'SHA256', '/f', pfxPath, '/p', opts.certPassword, opts.outPath],
    { stdio: 'inherit' }
  );

  console.log(`[package:msix] Signed MSIX created at: ${opts.outPath}`);
  console.log(`[package:msix] Public certificate exported at: ${cerPath}`);

  if (opts.install) {
    installMsixLocally(opts.outPath, cerPath, opts.version);
  }
}

main();
