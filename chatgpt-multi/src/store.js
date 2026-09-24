'use strict';

// The account list, persisted as profiles.json in the app's data folder. Each
// account's cookies and storage live in their own Electron partition
// ("persist:<id>"), i.e. <userData>/Partitions/<id>.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeName } = require('./policy');

const VERSION = 1;
const MAX_PROFILES = 12;
const ID_PATTERN = /^acct-[0-9a-f]{12}$/;
const COLORS = [
  '#10a37f',
  '#3b82f6',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#64748b',
];
const MIN_WINDOW = { width: 640, height: 420 };

function defaultName(profiles) {
  for (let index = 0; index < 26; index++) {
    const name = `账号 ${String.fromCodePoint(65 + index)}`;
    if (!profiles.some(profile => profile.name === name)) {
      return name;
    }
  }
  return `账号 ${profiles.length + 1}`;
}

function pickColor(profiles) {
  const used = new Set(profiles.map(profile => profile.color));
  return (
    COLORS.find(color => !used.has(color)) ??
    COLORS[profiles.length % COLORS.length]
  );
}

function createProfile(profiles, name) {
  return {
    id: `acct-${crypto.randomBytes(6).toString('hex')}`,
    name: sanitizeName(name) ?? defaultName(profiles),
    color: pickColor(profiles),
  };
}

// Used on first start, or to rebuild the list around account data that is
// already on disk when profiles.json is missing or unreadable.
function defaultState(existingIds = []) {
  const profiles = [];
  for (const id of existingIds.slice(0, MAX_PROFILES)) {
    profiles.push({
      id,
      name: defaultName(profiles),
      color: pickColor(profiles),
    });
  }
  if (profiles.length === 0) {
    profiles.push(createProfile(profiles));
    profiles.push(createProfile(profiles));
  }
  return {
    version: VERSION,
    profiles,
    activeId: profiles[0].id,
    split: false,
    window: null,
    purge: [],
  };
}

function normalizeWindow(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isInteger)) {
    return null;
  }
  return {
    x,
    y,
    width: Math.max(width, MIN_WINDOW.width),
    height: Math.max(height, MIN_WINDOW.height),
    maximized: value.maximized === true,
  };
}

// Returns a clean state, or null when the data is not a profiles file at all.
function normalize(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.version !== VERSION ||
    !Array.isArray(raw.profiles)
  ) {
    return null;
  }
  const profiles = [];
  for (const entry of raw.profiles) {
    if (profiles.length >= MAX_PROFILES) {
      break;
    }
    if (
      !entry ||
      !ID_PATTERN.test(entry.id) ||
      profiles.some(profile => profile.id === entry.id)
    ) {
      continue;
    }
    profiles.push({
      id: entry.id,
      name: sanitizeName(entry.name) ?? defaultName(profiles),
      color: COLORS.includes(entry.color) ? entry.color : pickColor(profiles),
    });
  }
  const ids = new Set(profiles.map(profile => profile.id));
  const purge = Array.isArray(raw.purge)
    ? [...new Set(raw.purge)].filter(id => ID_PATTERN.test(id) && !ids.has(id))
    : [];
  return {
    version: VERSION,
    profiles,
    activeId: ids.has(raw.activeId) ? raw.activeId : (profiles[0]?.id ?? null),
    split: raw.split === true,
    window: normalizeWindow(raw.window),
    purge,
  };
}

function existingPartitions(partitionsDir) {
  try {
    return fs
      .readdirSync(partitionsDir)
      .filter(name => ID_PATTERN.test(name))
      .sort();
  } catch {
    return [];
  }
}

function load(file, partitionsDir) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultState(existingPartitions(partitionsDir));
  }
  try {
    const state = normalize(JSON.parse(text));
    if (state) {
      return state;
    }
  } catch {
    // Unreadable JSON: handled below.
  }
  // Keep the damaged file for inspection and carry on with the accounts
  // whose data is still on disk, so nobody gets logged out by a bad write.
  try {
    fs.copyFileSync(file, `${file}.corrupt`);
  } catch {
    // Best effort only.
  }
  return defaultState(existingPartitions(partitionsDir));
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

module.exports = {
  COLORS,
  ID_PATTERN,
  MAX_PROFILES,
  createProfile,
  defaultState,
  load,
  normalize,
  save,
};
