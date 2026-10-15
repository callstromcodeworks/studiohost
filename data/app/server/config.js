// @ts-check
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The OBS plugin sets STUDIOHOST_DATA to its own config folder. Standalone runs default to ~/.studiohost.
export const DATA_DIR = resolve(process.env.STUDIOHOST_DATA || join(homedir(), '.studiohost'));
export const MANAGED = process.argv.includes('--managed') || process.env.STUDIOHOST_MANAGED === '1';
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

/**
 * @typedef {Object} StudioConfig
 * @property {number} localPort          HTTP port bound to 127.0.0.1 for OBS browser sources and the dock.
 * @property {import('./network.js').NetworkSettings} [network]  How guests reach Studio Host (set by the setup wizard).
 * @property {string} [bindAddress]      v0.1/0.2 settings, migrated to `network` (manual) on first start
 * @property {number} [publicPort]
 * @property {string} [publicUrl]
 * @property {{cert: string, key: string, selfSigned?: boolean}} [tls]
 * @property {RTCIceServerLike[]} iceServers  STUN/TURN servers handed to every browser.
 * @property {string} hostKey            Secret that unlocks host controls when not on localhost.
 * @property {string} guestKey           Invite token included in the guest link.
 * @property {number} maxGuests
 * @property {{width: number, height: number, fps: number}} output
 * @property {{url: string, password: string, sceneName: string, slots: number}} obs
 */

/** @typedef {{urls: string | string[], username?: string, credential?: string}} RTCIceServerLike */

const token = () => randomBytes(12).toString('base64url');

/** @returns {StudioConfig} */
function defaults() {
  return {
    localPort: 8730,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    hostKey: token(),
    guestKey: token(),
    maxGuests: 10,
    output: { width: 1920, height: 1080, fps: 30 },
    obs: { url: 'ws://127.0.0.1:4455', password: '', sceneName: 'Studio Host', slots: 4 },
  };
}

/**
 * Loads data/config.json, creating it with fresh secrets on first run.
 * Unknown keys are kept; missing keys are filled from defaults.
 * @returns {StudioConfig}
 */
export function loadConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  const base = defaults();
  let fromDisk = {};
  if (existsSync(CONFIG_PATH)) {
    fromDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  }
  const merged = {
    ...base,
    ...fromDisk,
    output: { ...base.output, ...(fromDisk.output || {}) },
    obs: { ...base.obs, ...(fromDisk.obs || {}) },
  };
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  }
  // Environment overrides apply to this run only and are never written back.
  if (process.env.STUDIOHOST_LOCAL_PORT) merged.localPort = Number(process.env.STUDIOHOST_LOCAL_PORT);
  return merged;
}

/**
 * Merges `patch` into data/config.json on disk (the running config is not changed;
 * the server restarts to apply it).
 * @param {Record<string, any>} patch
 */
export function saveConfigPatch(patch) {
  const current = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const next = { ...current, ...patch };
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, CONFIG_PATH);
}
