'use strict';

// Drives the real app. Every account session answers HTTPS with a local mock
// page, so no request reaches chatgpt.com; links meant for the system browser
// and confirmation dialogs are captured in the main process.
//
// Run with: npm run test:e2e   (on Linux wrap it in xvfb-run when headless)
// ELECTRON_PATH may point at another Electron build to run against.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { _electron: electron } = require('playwright-core');

const appDir = path.join(__dirname, '..', '..');
const artifacts = path.join(appDir, 'test-results');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-multi-e2e-'));
const userData = path.join(home, '.config', 'ChatGPT Multi');

let app;
let ui;

async function launch() {
  app = await electron.launch({
    executablePath: process.env.ELECTRON_PATH || undefined,
    args: [appDir],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
    },
  });
  await app.firstWindow();
  // Playwright lists every page, account views included: pick the tab strip.
  ui = await waitFor(() =>
    app.windows().find(page => page.url().startsWith('app://ui/')),
  );
  await ui.locator('.tab').first().waitFor();
  await app.evaluate(({ dialog, shell }) => {
    globalThis.opened = [];
    globalThis.dialogResponse = 0;
    shell.openExternal = async url => {
      globalThis.opened.push(url);
    };
    dialog.showMessageBox = async () => ({
      response: globalThis.dialogResponse,
      checkboxChecked: false,
    });
  });
  await mockNetwork();
}

async function mockNetwork() {
  await app.evaluate(({ BrowserWindow, session, webContents }) => {
    globalThis.mocked ??= new WeakSet();
    for (const contents of webContents.getAllWebContents()) {
      const accountSession = contents.session;
      if (
        accountSession === session.defaultSession ||
        globalThis.mocked.has(accountSession)
      ) {
        continue;
      }
      globalThis.mocked.add(accountSession);
      accountSession.protocol.handle('https', request => {
        const { host } = new URL(request.url);
        return new Response(
          `<!doctype html><title>Mock ${host}</title><h1>${host}</h1>`,
          { headers: { 'content-type': 'text/html' } },
        );
      });
    }
    // Reload whatever tried the real network before the mock was in place.
    const [main] = BrowserWindow.getAllWindows();
    for (const view of main.contentView.children) {
      const contents = view.webContents;
      if (contents?.session.storagePath?.includes('Partitions')) {
        contents.loadURL('https://chatgpt.com/').catch(() => {});
      }
    }
  });
  await waitFor(async () =>
    (await accounts()).every(account => account.title === 'Mock chatgpt.com'),
  );
}

// The account views in tab order, with their partition folder name.
function accounts() {
  return app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().startsWith('app://ui/'),
    );
    return main.contentView.children
      .filter(view =>
        view.webContents?.session.storagePath?.includes('Partitions'),
      )
      .map(view => ({
        id: view.webContents.id,
        partition: view.webContents.session.storagePath
          .split(/[\\/]/)
          .findLast(Boolean),
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        visible: view.getVisible(),
        bounds: view.getBounds(),
      }));
  });
}

function popups() {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter(
        window =>
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          !window.webContents.getURL().startsWith('app://ui/'),
      )
      .map(window => ({
        id: window.id,
        url: window.webContents.getURL(),
        partition: window.webContents.session.storagePath
          .split(/[\\/]/)
          .findLast(Boolean),
      })),
  );
}

function run(contentsId, source) {
  return app.evaluate(
    ({ webContents }, [id, code]) =>
      webContents.fromId(id).executeJavaScript(code, true),
    [contentsId, source],
  );
}

function opened() {
  return app.evaluate(() => globalThis.opened);
}

function readState() {
  return JSON.parse(
    fs.readFileSync(path.join(userData, 'profiles.json'), 'utf8'),
  );
}

function tabNames() {
  return ui.locator('.tab .name').allTextContents();
}

async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${check}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe('ChatGPT Multi', { timeout: 180_000 }, () => {
  before(launch);
  after(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('starts with two accounts, each in its own partition', async () => {
    assert.deepEqual(await tabNames(), ['账号 A', '账号 B']);
    const [a, b] = await accounts();
    const { profiles } = readState();
    assert.deepEqual(
      [a.partition, b.partition],
      profiles.map(profile => profile.id),
    );
    assert.notEqual(a.partition, b.partition);
    assert.equal(a.visible, true);
    assert.equal(b.visible, false);
  });

  it('keeps cookies and storage separate between accounts', async () => {
    const [a, b] = await accounts();
    // Persistent, like a real login cookie, so the restart test can look for it.
    await run(
      a.id,
      'document.cookie = "who=A; Secure; Path=/; Max-Age=86400"; localStorage.setItem("who", "A"); 1',
    );
    assert.equal(await run(a.id, 'document.cookie'), 'who=A');
    assert.equal(await run(b.id, 'document.cookie'), '');
    assert.equal(await run(b.id, 'localStorage.getItem("who")'), null);
  });

  it('gives account pages no Node.js, no app bridge and a plain Chrome identity', async () => {
    const [a] = await accounts();
    assert.equal(
      await run(
        a.id,
        'typeof require + typeof process + typeof window.chatgptMulti',
      ),
      'undefinedundefinedundefined',
    );
    const userAgent = await run(a.id, 'navigator.userAgent');
    assert.match(userAgent, /Chrome\/\d+\.0\.0\.0 Safari/);
    assert.doesNotMatch(userAgent, /Electron|ChatGPT Multi/);
    assert.equal(
      await run(
        a.id,
        'fetch("app://ui/index.html").then(() => "reachable", () => "blocked")',
      ),
      'blocked',
    );
  });

  it('opens ordinary links in the system browser instead of the app', async () => {
    const [a] = await accounts();
    await run(a.id, 'window.open("https://example.com/article"); 1');
    await waitFor(async () =>
      (await opened()).includes('https://example.com/article'),
    );
    await run(
      a.id,
      'location.href = "https://example.org/look-alike-login"; 1',
    );
    await waitFor(async () =>
      (await opened()).includes('https://example.org/look-alike-login'),
    );
    const [after] = await accounts();
    assert.equal(after.url, 'https://chatgpt.com/');
    assert.deepEqual(await popups(), []);
  });

  it('never hands local files or other schemes to the system', async () => {
    const [a] = await accounts();
    await run(
      a.id,
      'window.open("file:///etc/passwd"); window.open("smb://host/share"); location.href = "file:///etc/passwd"; 1',
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(
      (await opened()).filter(url => !url.startsWith('https:')),
      [],
    );
    assert.equal((await accounts())[0].url, 'https://chatgpt.com/');
  });

  it('keeps sign-in popups inside the same account', async () => {
    const [a] = await accounts();
    await run(
      a.id,
      'window.open("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"); 1',
    );
    const [popup] = await waitFor(async () => {
      const list = await popups();
      return (
        list.length > 0 &&
        list[0].url.startsWith('https://accounts.google.com/') &&
        list
      );
    });
    assert.equal(popup.partition, a.partition);
    await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(),
      popup.id,
    );
    await waitFor(async () => (await popups()).length === 0);
  });

  it('grants only the permissions ChatGPT needs', async () => {
    const [a] = await accounts();
    const states = await run(
      a.id,
      'Promise.all(["notifications", "microphone", "camera", "geolocation"].map(name => navigator.permissions.query({ name }).then(result => result.state)))',
    );
    assert.deepEqual(states, ['granted', 'granted', 'denied', 'denied']);
    const geolocation = await run(
      a.id,
      'new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve("allowed"), error => resolve(error.code)))',
    );
    assert.equal(geolocation, 1); // PERMISSION_DENIED
  });

  it('adds, names and switches accounts from the tab strip', async () => {
    await ui.click('#add');
    const input = ui.locator('.tab .rename');
    await input.waitFor();
    await input.fill('工作号');
    await input.press('Enter');
    await waitFor(
      async () => (await tabNames()).join() === '账号 A,账号 B,工作号',
    );
    await mockNetwork();
    const list = await accounts();
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map(account => account.visible),
      [false, false, true],
    );
    const state = readState();
    assert.equal(state.profiles[2].name, '工作号');
    assert.equal(state.activeId, state.profiles[2].id);

    await ui.locator('.tab').first().click();
    await waitFor(async () => (await accounts())[0].visible);
    assert.equal(readState().activeId, state.profiles[0].id);
  });

  it('keeps keyboard focus on the account that is on screen', async () => {
    const [a, b] = await accounts();
    assert.equal(a.visible, true);
    // Chromium focuses a page when it finishes loading, even a hidden one.
    await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id).reload(),
      b.id,
    );
    await new Promise(resolve => setTimeout(resolve, 1000));
    const focused = await app.evaluate(
      ({ webContents }) => webContents.getFocusedWebContents()?.id,
    );
    assert.equal(focused, a.id);
    const [stillA, stillHiddenB] = await accounts();
    assert.equal(stillA.visible, true);
    assert.equal(stillHiddenB.visible, false);
    assert.equal(readState().activeId, readState().profiles[0].id);
  });

  it('shows every account side by side in split view', async () => {
    await ui.click('#split');
    await waitFor(async () => (await ui.locator('.pane').count()) === 3);
    const list = await accounts();
    assert.ok(list.every(account => account.visible));

    // Clicking into a page makes that account the active one.
    const { profiles } = readState();
    await app.evaluate(({ webContents }, id) => {
      webContents.fromId(id).sendInputEvent({
        type: 'mouseDown',
        x: 40,
        y: 40,
        button: 'left',
        clickCount: 1,
      });
    }, list[1].id);
    await waitFor(() => readState().activeId === profiles[1].id);
    await waitFor(
      async () =>
        (await ui.locator('.pane.active .pane-name').textContent()) ===
        '账号 B',
    );
    const [first, second, third] = list.map(account => account.bounds);
    assert.equal(first.y, second.y);
    assert.equal(second.y, third.y);
    assert.ok(first.x + first.width < second.x);
    assert.ok(second.x + second.width < third.x);
    assert.deepEqual(await ui.locator('.pane .pane-name').allTextContents(), [
      '账号 A',
      '账号 B',
      '工作号',
    ]);
    fs.mkdirSync(artifacts, { recursive: true });
    await ui.screenshot({
      path: path.join(artifacts, 'split-view-frames.png'),
    });
    await ui.click('#split');
    await waitFor(async () => (await ui.locator('.pane').count()) === 0);
    await ui.locator('.tab').first().click();
    await waitFor(() => readState().activeId === profiles[0].id);
  });

  it('removes an account and wipes its data', async () => {
    const removed = readState().profiles[2];
    const [, , third] = await accounts();
    await run(third.id, 'document.cookie = "who=work; Secure; Path=/"; 1');
    await app.evaluate(() => {
      globalThis.dialogResponse = 1; // "Cancel"
    });
    await ui.locator('.tab').nth(2).locator('.close').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await tabNames()).length, 3);

    await app.evaluate(() => {
      globalThis.dialogResponse = 0; // "Delete"
    });
    await ui.locator('.tab').nth(2).locator('.close').click();
    await waitFor(async () => (await tabNames()).length === 2);
    const state = readState();
    assert.deepEqual(state.purge, [removed.id]);
    assert.ok(!state.profiles.some(profile => profile.id === removed.id));
    const cookies = await waitFor(async () => {
      const found = await app.evaluate(
        ({ session }, id) =>
          session.fromPartition(`persist:${id}`).cookies.get({}),
        removed.id,
      );
      return found.length === 0 && found;
    });
    assert.deepEqual(cookies, []);
  });

  it('serves the tab strip only from its own folder', async () => {
    const statuses = await app.evaluate(({ net }) =>
      Promise.all(
        [
          'app://ui/index.html',
          'app://ui/../main.js',
          'app://ui/%2e%2e/main.js',
          'app://ui/..%2fmain.js',
          'app://ui/..%5cmain.js',
          'app://other/index.html',
        ].map(url =>
          net.fetch(url).then(
            response => response.status,
            () => 'error',
          ),
        ),
      ),
    );
    assert.deepEqual(statuses, [200, 404, 404, 404, 404, 404]);
  });

  it('restores accounts after a restart and deletes removed data for good', async () => {
    const { purge } = readState();
    assert.ok(fs.existsSync(path.join(userData, 'Partitions', purge[0])));
    await app.close();
    await launch();
    assert.deepEqual(await tabNames(), ['账号 A', '账号 B']);
    assert.ok(!fs.existsSync(path.join(userData, 'Partitions', purge[0])));
    assert.deepEqual(readState().purge, []);
    const [a] = await accounts();
    assert.equal(await run(a.id, 'document.cookie'), 'who=A');
  });
});
