import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const GFN_DIR = path.join(
  process.env.LOCALAPPDATA || '',
  'NVIDIA Corporation',
  'GeForceNOW'
);

const GFN_EXE = path.join(GFN_DIR, 'CEF', 'GeForceNOW.exe');

// Resolve profiles relative to this file's directory, not process.cwd(),
// so imports from src/ still find the right folder.
const __switcher_dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__switcher_dirname, 'profiles');
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9._ -]{1,80}$/;

// Ensure profiles directory exists.
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Source files/folders to backup/restore.
const TARGETS = [
  {
    name: 'sharedstorage.json',
    srcPath: path.join(GFN_DIR, 'sharedstorage.json'),
    relPath: 'sharedstorage.json',
    type: 'file',
  },
  {
    name: 'Cookies',
    srcPath: path.join(GFN_DIR, 'CefCache', 'Default', 'Network', 'Cookies'),
    relPath: 'Cookies',
    type: 'file',
  },
  {
    name: 'Local Storage',
    srcPath: path.join(GFN_DIR, 'CefCache', 'Default', 'Local Storage'),
    relPath: 'LocalStorage',
    type: 'dir',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
// Helper to check if GFN is running
export function isGFNRunning(): boolean {
  try {
    const pidsOutput = execSync(
      'powershell -Command "Get-Process -Name *GeForceNOW* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"',
      { encoding: 'utf8' }
    ).trim();
    return !!pidsOutput;
  } catch (e) {
    return false;
  }
}

// Helper to kill GFN processes
function killGFN(): void {
  console.log('[GFN-Switcher] Checking for running GeForce NOW processes...');
  try {
    if (isGFNRunning()) {
      console.log('[GFN-Switcher] Closing GeForce NOW to release file locks...');
      execSync('powershell -Command "Stop-Process -Name *GeForceNOW* -Force"', {
        stdio: 'inherit',
      });
      execSync('powershell -Command "Start-Sleep -Seconds 2"');
      console.log('[GFN-Switcher] GeForce NOW stopped successfully.');
    } else {
      console.log('[GFN-Switcher] GeForce NOW is not running.');
    }
  } catch (e) {
    console.error('[GFN-Switcher] Error stopping GeForce NOW:', (e as Error).message);
  }
}

function launchGFN(): void {
  console.log('[GFN-Switcher] Starting GeForce NOW...');
  if (fs.existsSync(GFN_EXE)) {
    const child = spawn(GFN_EXE, [], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('[GFN-Switcher] GeForce NOW launched.');
  } else {
    console.error(`[GFN-Switcher] Error: GeForce NOW executable not found at: ${GFN_EXE}`);
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function deleteDirSync(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function resolveProfileDir(profileName: string): string {
  const trimmed = profileName.trim();
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new Error('Profile name must be 1-80 characters and may only contain letters, numbers, spaces, dots, underscores, and hyphens.');
  }

  const profileDir = path.resolve(PROFILES_DIR, trimmed);
  const profilesRoot = path.resolve(PROFILES_DIR);
  if (profileDir !== profilesRoot && profileDir.startsWith(`${profilesRoot}${path.sep}`)) {
    return profileDir;
  }
  throw new Error('Invalid profile path.');
}

// ─── Exported API ───────────────────────────────────────────────────────────

export interface GfnProfileInfo {
  name: string;
  username: string;
  email: string;
}

/**
 * Extract account details from a sharedstorage.json file.
 * The session data is Base64-encoded, then URL-encoded JSON.
 */
export function getAccountInfo(sharedStoragePath: string): { username: string; email: string } | null {
  try {
    if (!fs.existsSync(sharedStoragePath)) return null;
    const content = fs.readFileSync(sharedStoragePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed.starfleetSession && parsed.starfleetSession.data) {
      const base64Decoded = Buffer.from(parsed.starfleetSession.data, 'base64').toString('utf8');
      const decodedData = decodeURIComponent(base64Decoded);
      const sessionData = JSON.parse(decodedData);
      if (sessionData.user) {
        return {
          username: sessionData.user.preferred_username || 'Unknown',
          email: sessionData.user.email || 'Unknown',
        };
      }
    }
  } catch {
    // Ignore parsing errors
  }
  return null;
}

/**
 * List all saved GFN profiles with their decoded account info.
 */
export function listProfiles(): GfnProfileInfo[] {
  const profiles: GfnProfileInfo[] = [];
  try {
    const folders = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    for (const folder of folders) {
      const sharedStoragePath = path.join(PROFILES_DIR, folder, 'sharedstorage.json');
      const info = getAccountInfo(sharedStoragePath);
      profiles.push({
        name: folder,
        username: info?.username ?? 'Unknown',
        email: info?.email ?? 'Unknown',
      });
    }
  } catch (e) {
    console.error('[GFN-Switcher] Error reading profiles:', (e as Error).message);
  }
  return profiles;
}

/**
 * Save the currently active GFN session as a named profile.
 * Kills GFN to release file locks, copies files, then restarts GFN.
 */
export function saveProfile(profileName: string): void {
  const profileDir = resolveProfileDir(profileName);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const currentInfo = getAccountInfo(path.join(GFN_DIR, 'sharedstorage.json'));
  console.log(`[GFN-Switcher] Saving profile '${profileName}'...`);
  if (currentInfo) {
    console.log(`[GFN-Switcher] Account details: ${currentInfo.username} (${currentInfo.email})`);
  } else {
    console.log('[GFN-Switcher] Account details: No active login found (guest/logged out).');
  }

  killGFN();

  for (const target of TARGETS) {
    const destPath = path.join(profileDir, target.relPath);
    if (!fs.existsSync(target.srcPath)) {
      console.warn(`[GFN-Switcher] Warning: Source does not exist: ${target.srcPath}`);
      continue;
    }
    try {
      if (target.type === 'file') {
        fs.copyFileSync(target.srcPath, destPath);
        console.log(`[GFN-Switcher] Saved file: ${target.name}`);
      } else {
        deleteDirSync(destPath);
        copyDirSync(target.srcPath, destPath);
        console.log(`[GFN-Switcher] Saved directory: ${target.name}`);
      }
    } catch (e) {
      console.error(`[GFN-Switcher] Failed to save ${target.name}:`, (e as Error).message);
    }
  }

  console.log(`[GFN-Switcher] Successfully saved profile '${profileName}'!`);
  launchGFN();
}

/**
 * Load a saved profile into the active GFN installation.
 * Kills GFN, restores all session files, then launches GFN.
 * Returns the profile info or null if the profile doesn't exist.
 */
export function loadProfile(profileName: string): GfnProfileInfo | null {
  const profileDir = resolveProfileDir(profileName);
  if (!fs.existsSync(profileDir)) {
    console.error(`[GFN-Switcher] Error: Profile '${profileName}' does not exist.`);
    return null;
  }

  const profileInfo = getAccountInfo(path.join(profileDir, 'sharedstorage.json'));
  console.log(`[GFN-Switcher] Loading profile '${profileName}'...`);
  if (profileInfo) {
    console.log(`[GFN-Switcher] Target account: ${profileInfo.username} (${profileInfo.email})`);
  }

  killGFN();

  for (const target of TARGETS) {
    const savedPath = path.join(profileDir, target.relPath);
    if (!fs.existsSync(savedPath)) {
      console.warn(`[GFN-Switcher] Warning: Saved backup does not exist for: ${target.name}`);
      continue;
    }
    try {
      if (target.type === 'file') {
        const parentDir = path.dirname(target.srcPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.copyFileSync(savedPath, target.srcPath);
        console.log(`[GFN-Switcher] Restored file: ${target.name}`);
      } else {
        deleteDirSync(target.srcPath);
        copyDirSync(savedPath, target.srcPath);
        console.log(`[GFN-Switcher] Restored directory: ${target.name}`);
      }
    } catch (e) {
      console.error(`[GFN-Switcher] Failed to restore ${target.name}:`, (e as Error).message);
    }
  }

  console.log(`[GFN-Switcher] Successfully loaded profile '${profileName}'!`);
  launchGFN();

  return {
    name: profileName,
    username: profileInfo?.username ?? 'Unknown',
    email: profileInfo?.email ?? 'Unknown',
  };
}

/**
 * Delete a saved profile from disk.
 */
export function deleteProfile(profileName: string): boolean {
  const profileDir = resolveProfileDir(profileName);
  if (!fs.existsSync(profileDir)) {
    return false;
  }
  deleteDirSync(profileDir);
  console.log(`[GFN-Switcher] Deleted profile '${profileName}'.`);
  return true;
}

/**
 * Clear the active GFN session files (blank state logout).
 * Kills GFN, deletes session files, then relaunches GFN.
 */
export function logout(): void {
  console.log('[GFN-Switcher] Logging out / clearing active GeForce NOW session...');
  killGFN();

  for (const target of TARGETS) {
    if (fs.existsSync(target.srcPath)) {
      try {
        if (target.type === 'file') {
          fs.unlinkSync(target.srcPath);
          console.log(`[GFN-Switcher] Deleted active file: ${target.name}`);
        } else {
          deleteDirSync(target.srcPath);
          console.log(`[GFN-Switcher] Deleted active directory: ${target.name}`);
        }
      } catch (e) {
        console.error(`[GFN-Switcher] Failed to delete ${target.name}:`, (e as Error).message);
      }
    }
  }

  console.log('[GFN-Switcher] GeForce NOW active session cleared successfully (blank state).');
  launchGFN();
}

// ─── CLI entry point ────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const param = args[1];

  if (command === 'save' && param) {
    saveProfile(param);
  } else if (command === 'load' && param) {
    loadProfile(param);
  } else if (command === 'list') {
    const profiles = listProfiles();
    console.log('Saved GFN Profiles:');
    console.log('==================');
    if (profiles.length === 0) {
      console.log('No profiles saved yet. Use: npx tsx gfn-switcher/switcher.ts save <name>');
    } else {
      for (const p of profiles) {
        console.log(`- ${p.name.padEnd(20)} [User: ${p.username} | ${p.email}]`);
      }
    }
  } else if (command === 'logout' || command === 'clear') {
    logout();
  } else if ((command === 'delete' || command === 'remove') && param) {
    if (!deleteProfile(param)) {
      console.error(`[GFN-Switcher] Profile '${param}' does not exist.`);
      process.exitCode = 1;
    }
  } else {
    console.log(`
GeForce NOW Account Switcher CLI
===============================
Usage:
  npx tsx gfn-switcher/switcher.ts save <profile_name>  - Save current login session as <profile_name>
  npx tsx gfn-switcher/switcher.ts load <profile_name>  - Load <profile_name> session (Kills GFN, restores, launches GFN)
  npx tsx gfn-switcher/switcher.ts delete <profile_name> - Delete saved <profile_name>
  npx tsx gfn-switcher/switcher.ts list                 - List all saved profiles
  npx tsx gfn-switcher/switcher.ts logout               - Clear active GFN session (Logout to a blank state safely)
    `);
  }
}

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
