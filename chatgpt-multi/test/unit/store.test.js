'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');
const store = require('../../src/store');

let dir;
let file;
let partitions;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-multi-store-'));
  file = path.join(dir, 'profiles.json');
  partitions = path.join(dir, 'Partitions');
});

describe('first start', () => {
  it('creates two accounts, A and B, with their own ids and colours', () => {
    const state = store.load(file, partitions);
    assert.deepEqual(
      state.profiles.map(profile => profile.name),
      ['账号 A', '账号 B'],
    );
    const [a, b] = state.profiles;
    assert.match(a.id, store.ID_PATTERN);
    assert.match(b.id, store.ID_PATTERN);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.color, b.color);
    assert.equal(state.activeId, a.id);
    assert.equal(state.split, false);
    assert.deepEqual(state.purge, []);
  });
});

describe('save and load', () => {
  it('round-trips the account list', () => {
    const state = store.load(file, partitions);
    state.profiles[1].name = '工作号';
    state.split = true;
    state.window = { x: 10, y: 20, width: 1000, height: 700, maximized: true };
    store.save(file, state);
    assert.deepEqual(store.load(file, partitions), state);
  });

  it('does not leave temporary files behind', () => {
    store.save(file, store.defaultState());
    assert.deepEqual(fs.readdirSync(dir), ['profiles.json']);
  });
});

describe('damaged or missing profiles.json', () => {
  it('keeps the damaged file and recovers accounts still on disk', () => {
    const ids = ['acct-00000000000b', 'acct-00000000000a'];
    for (const id of [...ids, 'Default', 'acct-bad', 'other']) {
      fs.mkdirSync(path.join(partitions, id), { recursive: true });
    }
    fs.writeFileSync(file, '{ not json');
    const state = store.load(file, partitions);
    assert.deepEqual(
      state.profiles.map(profile => profile.id),
      [...ids].sort(),
    );
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{ not json');
  });

  it('recovers accounts when the file is missing', () => {
    fs.mkdirSync(path.join(partitions, 'acct-0123456789ab'), {
      recursive: true,
    });
    const state = store.load(file, partitions);
    assert.deepEqual(
      state.profiles.map(profile => profile.id),
      ['acct-0123456789ab'],
    );
  });
});

describe('normalize', () => {
  it('drops invalid and duplicate accounts and cleans names and colours', () => {
    const state = store.normalize({
      version: 1,
      profiles: [
        { id: 'acct-000000000001', name: '  A‮  ', color: '#10a37f' },
        { id: 'acct-000000000001', name: 'duplicate', color: '#3b82f6' },
        { id: '../../etc', name: 'bad id', color: '#3b82f6' },
        { id: 'acct-000000000002', name: '', color: 'red; background: url(x)' },
      ],
      activeId: 'acct-missing',
      split: 'yes',
      purge: [
        'acct-000000000001',
        'acct-000000000003',
        '../../home',
        'acct-000000000003',
      ],
      window: { x: 1.5, y: 0, width: 10, height: 10 },
    });
    assert.deepEqual(state.profiles, [
      { id: 'acct-000000000001', name: 'A', color: '#10a37f' },
      { id: 'acct-000000000002', name: '账号 A', color: '#3b82f6' },
    ]);
    assert.equal(state.activeId, 'acct-000000000001');
    assert.equal(state.split, false);
    assert.deepEqual(state.purge, ['acct-000000000003']);
    assert.equal(state.window, null);
  });

  it('allows an empty account list', () => {
    const state = store.normalize({ version: 1, profiles: [] });
    assert.deepEqual(state.profiles, []);
    assert.equal(state.activeId, null);
  });

  it('enforces a minimum window size', () => {
    const state = store.normalize({
      version: 1,
      profiles: [],
      window: { x: 0, y: 0, width: 100, height: 100 },
    });
    assert.deepEqual(state.window, {
      x: 0,
      y: 0,
      width: 640,
      height: 420,
      maximized: false,
    });
  });

  it('rejects data that is not a profiles file', () => {
    for (const raw of [
      null,
      [],
      'text',
      { version: 2, profiles: [] },
      { version: 1 },
    ]) {
      assert.equal(store.normalize(raw), null);
    }
  });
});

describe('createProfile', () => {
  it('picks the next free letter and colour', () => {
    const state = store.defaultState();
    const profile = store.createProfile(state.profiles);
    assert.equal(profile.name, '账号 C');
    assert.ok(
      !state.profiles.some(existing => existing.color === profile.color),
    );
  });

  it('uses a given name when it is valid', () => {
    assert.equal(store.createProfile([], ' 工作号 ').name, '工作号');
  });
});
