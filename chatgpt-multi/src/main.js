'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
} = require('electron');
const { METRICS, computeLayout } = require('./layout');
const policy = require('./policy');
const store = require('./store');

const APP_ID = 'io.github.henryleo180.chatgpt-multi';
const HOME_URL = 'https://chatgpt.com/';
const UI_URL = 'app://ui/index.html';
const UI_DIR = path.join(__dirname, 'ui');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ERR_ABORTED = -3;
const isMac = process.platform === 'darwin';

const stateFile = path.join(app.getPath('userData'), 'profiles.json');
const partitionsDir = path.join(app.getPath('userData'), 'Partitions');

// The tab strip page is served from app://ui/ rather than file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } },
]);
// Present a plain Chrome user agent: some sign-in pages (Google's in
// particular) refuse browsers that identify themselves as Electron.
app.userAgentFallback = chromeUserAgent();

let state;
let win = null;
let panes = [];
let statePushQueued = false;
const tabs = new Map();
const hardenedSessions = new WeakSet();

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', focusWindow);
  app.on('web-contents-created', (_event, contents) => {
    // Safety net for every page, including ones created later: no <webview>
    // tags, and no new windows unless guardContents() allows them.
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch(error => {
      dialog.showErrorBox(
        'ChatGPT Multi 启动失败',
        String(error?.stack ?? error),
      );
      app.quit();
    });
} else {
  // Two copies must never share the same account databases.
  app.quit();
}

function start() {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
  state = store.load(stateFile, partitionsDir);
  purgeRemovedAccounts();
  // Written straight away so the account list always matches the folders on disk.
  persist();
  disableSpellChecker(session.defaultSession);
  registerUiProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!win) {
      createWindow();
    }
  });
}

// A removed account is wiped from its running session right away; its folder
// is deleted here, on the next start, before anything can have it open.
function purgeRemovedAccounts() {
  state.purge = state.purge.filter(id => {
    try {
      fs.rmSync(path.join(partitionsDir, id), { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  });
}

function registerUiProtocol() {
  protocol.handle('app', async request => {
    try {
      const url = new URL(request.url);
      const file = path.join(
        UI_DIR,
        path.normalize(decodeURIComponent(url.pathname)),
      );
      const relative = path.relative(UI_DIR, file);
      if (
        url.host === 'ui' &&
        relative &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
      ) {
        const body = await fs.promises.readFile(file);
        return new Response(body, {
          headers: {
            'content-type':
              CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
          },
        });
      }
    } catch {
      // Answered with 404 below.
    }
    return new Response('Not found', { status: 404 });
  });
}

function createWindow() {
  const created = new BrowserWindow({
    ...initialBounds(),
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'ChatGPT 多账号',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#eef0f3',
    autoHideMenuBar: true,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      disableBlinkFeatures: 'Auxclick',
    },
  });
  win = created;

  created.webContents.on('will-navigate', event => event.preventDefault());
  created.webContents.loadURL(UI_URL).catch(error => console.error(error));
  created.once('ready-to-show', () => {
    created.show();
    if (state.window?.maximized) {
      created.maximize();
    }
    activeContents()?.focus();
  });

  for (const profile of state.profiles) {
    createTab(profile);
  }
  created.on('resize', layout);
  created.on('maximize', layout);
  created.on('unmaximize', layout);
  created.on('enter-full-screen', layout);
  created.on('leave-full-screen', layout);
  created.on('close', () => rememberWindow(created));
  created.on('closed', () => {
    // Views are not destroyed together with their window.
    for (const tab of tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close();
      }
    }
    tabs.clear();
    panes = [];
    win = null;
  });
  layout();
  buildMenu();
}

function initialBounds() {
  const saved = state.window;
  const visible =
    saved &&
    screen
      .getAllDisplays()
      .some(
        ({ workArea: area }) =>
          saved.x < area.x + area.width &&
          saved.x + saved.width > area.x &&
          saved.y < area.y + area.height &&
          saved.y + saved.height > area.y,
      );
  return visible
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: 1280, height: 860 };
}

function rememberWindow(window) {
  state.window = {
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
  };
  persist();
}

// One tab per account. Each gets its own persistent partition, so cookies,
// local storage and cache are never shared between accounts.
function createTab(profile) {
  const accountSession = session.fromPartition(`persist:${profile.id}`);
  hardenSession(accountSession);
  const view = new WebContentsView({
    webPreferences: {
      session: accountSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor(
    nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff',
  );
  view.setVisible(false);
  win.contentView.addChildView(view);

  const tab = { profile, view, title: '', loading: false, failed: false };
  tabs.set(profile.id, tab);

  const contents = view.webContents;
  guardContents(contents);
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title;
    pushState();
  });
  contents.on('did-start-loading', () => {
    tab.loading = true;
    tab.failed = false;
    pushState();
  });
  contents.on('did-stop-loading', () => {
    tab.loading = false;
    pushState();
  });
  contents.on(
    'did-fail-load',
    (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) {
        tab.failed = true;
        pushState();
      }
    },
  );
  contents.on('render-process-gone', (_event, details) => {
    tab.failed = details.reason !== 'clean-exit';
    pushState();
  });
  contents.on('did-navigate', pushState);
  contents.on('did-navigate-in-page', pushState);
  contents.on('before-mouse-event', (_event, mouse) => {
    // Clicking into a page in split view makes that account the active one.
    if (mouse.type === 'mouseDown' && state.activeId !== profile.id) {
      activate(profile.id, false);
    }
  });
  contents.on('focus', () => {
    // Chromium also hands focus to a page when it finishes loading, even a
    // hidden one. Keyboard input must stay with the account on screen; the
    // hand-over completes after this event, so take focus back afterwards.
    if (state.activeId !== profile.id) {
      setImmediate(() => {
        if (state.activeId !== profile.id) {
          activeContents()?.focus();
        }
      });
    }
  });
  load(contents, HOME_URL);
}

function hardenSession(accountSession) {
  if (hardenedSessions.has(accountSession)) {
    return;
  }
  hardenedSessions.add(accountSession);
  disableSpellChecker(accountSession);
  accountSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      const mediaTypes =
        'mediaTypes' in details ? details.mediaTypes : undefined;
      callback(
        policy.isPermissionAllowed(
          permission,
          details.requestingUrl,
          mediaTypes,
        ),
      );
    },
  );
  accountSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin, details) =>
      policy.isPermissionAllowed(
        permission,
        requestingOrigin,
        details.mediaType ? [details.mediaType] : undefined,
      ),
  );
  accountSession.setDevicePermissionHandler(() => false);
}

// Spell checking is off; without languages Chromium also skips downloading
// its dictionaries from Google's servers.
function disableSpellChecker(target) {
  target.setSpellCheckerEnabled(false);
  target.setSpellCheckerLanguages([]);
}

// Applied to every account page and to the login popups they open.
function guardContents(contents, isPopup = false) {
  contents.setWindowOpenHandler(({ url }) => {
    const decision = policy.windowOpenDecision(url);
    if (decision === 'popup') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(win ? { parent: win } : {}),
          width: 520,
          height: 720,
          autoHideMenuBar: true,
        },
      };
    }
    if (decision === 'external') {
      openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('did-create-window', child =>
    guardContents(child.webContents, true),
  );
  contents.on('will-navigate', event => {
    const decision = policy.navigationDecision(event.url, contents.getURL());
    if (decision === 'allow') {
      return;
    }
    event.preventDefault();
    if (decision === 'external') {
      openExternal(event.url);
      // A popup opened blank only to send the user elsewhere has nothing
      // left to show.
      if (isPopup && ['', 'about:blank'].includes(contents.getURL())) {
        setImmediate(() => contents.close());
      }
    }
  });
  contents.on('will-redirect', event => {
    if (!policy.redirectAllowed(event.url)) {
      event.preventDefault();
    }
  });
  contents.on('context-menu', (_event, params) =>
    showPageMenu(contents, params),
  );
}

function openExternal(url) {
  if (policy.isSafeExternalUrl(url)) {
    shell.openExternal(url).catch(error => console.error(error));
  }
}

function load(contents, url) {
  // Failures are reported through 'did-fail-load'.
  contents.loadURL(url).catch(() => {});
}

// Electron has no context menu of its own.
function showPageMenu(contents, params) {
  const { editFlags } = params;
  const groups = [];
  if (params.linkURL && policy.isSafeExternalUrl(params.linkURL)) {
    groups.push([
      {
        label: '在默认浏览器中打开链接',
        click: () => openExternal(params.linkURL),
      },
      {
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL),
      },
    ]);
  }
  if (params.mediaType === 'image') {
    groups.push([
      {
        label: '复制图片',
        click: () => contents.copyImageAt(params.x, params.y),
      },
    ]);
  }
  if (params.isEditable) {
    groups.push(
      [
        {
          label: '撤销',
          enabled: editFlags.canUndo,
          click: () => contents.undo(),
        },
        {
          label: '重做',
          enabled: editFlags.canRedo,
          click: () => contents.redo(),
        },
      ],
      [
        {
          label: '剪切',
          enabled: editFlags.canCut,
          click: () => contents.cut(),
        },
        {
          label: '复制',
          enabled: editFlags.canCopy,
          click: () => contents.copy(),
        },
        {
          label: '粘贴',
          enabled: editFlags.canPaste,
          click: () => contents.paste(),
        },
        {
          label: '全选',
          enabled: editFlags.canSelectAll,
          click: () => contents.selectAll(),
        },
      ],
    );
  } else if (params.selectionText.trim()) {
    groups.push([{ label: '复制', click: () => contents.copy() }]);
  }
  if (groups.length > 0) {
    Menu.buildFromTemplate(
      groups.flatMap((group, index) =>
        index === 0 ? group : [{ type: 'separator' }, ...group],
      ),
    ).popup();
  }
}

function layout() {
  if (!win) {
    return;
  }
  const [width, height] = win.getContentSize();
  panes = computeLayout({
    width,
    height,
    ids: state.profiles.map(({ id }) => id),
    activeId: state.activeId,
    split: state.split,
  });
  for (const [id, tab] of tabs) {
    const pane = panes.find(candidate => candidate.id === id);
    if (pane) {
      tab.view.setBounds(pane.view);
    }
    tab.view.setVisible(Boolean(pane));
  }
  pushState();
}

function activeContents() {
  const contents = tabs.get(state.activeId)?.view.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}

function activate(id, focus = true) {
  const tab = tabs.get(id);
  if (!tab) {
    return;
  }
  if (state.activeId !== id) {
    state.activeId = id;
    persist();
  }
  layout();
  if (focus) {
    tab.view.webContents.focus();
  }
}

function cycle(step) {
  const ids = state.profiles.map(({ id }) => id);
  if (ids.length > 0) {
    const index = ids.indexOf(state.activeId);
    activate(ids[(index + step + ids.length) % ids.length]);
  }
}

function addAccount() {
  if (!win) {
    return;
  }
  if (state.profiles.length >= store.MAX_PROFILES) {
    dialog
      .showMessageBox(win, {
        type: 'info',
        message: `最多可以添加 ${store.MAX_PROFILES} 个账号标签。`,
      })
      .catch(error => console.error(error));
    return;
  }
  const profile = store.createProfile(state.profiles);
  state.profiles.push(profile);
  createTab(profile);
  activate(profile.id, false);
  buildMenu();
  beginRename(profile.id);
}

function beginRename(id) {
  if (win && tabs.has(id)) {
    win.webContents.focus();
    win.webContents.send('begin-rename', id);
  }
}

function renameAccount(id, name) {
  const tab = tabs.get(id);
  const clean = policy.sanitizeName(name);
  if (tab && clean) {
    tab.profile.name = clean;
    persist();
    buildMenu();
  }
  pushState();
}

async function wipe(accountSession) {
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  await accountSession.clearAuthCache();
}

async function signOut(id) {
  const tab = tabs.get(id);
  if (!win || !tab) {
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['退出登录', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `退出「${tab.profile.name}」的登录？`,
    detail: '会清除这个标签的登录状态和缓存，之后可以在这里登录另一个账号。',
  });
  if (response !== 0 || !tabs.has(id)) {
    return;
  }
  await wipe(tab.view.webContents.session);
  load(tab.view.webContents, HOME_URL);
}

async function removeAccount(id) {
  const tab = tabs.get(id);
  if (!win || !tab) {
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除「${tab.profile.name}」？`,
    detail:
      '会退出这个账号，并清除它在本软件里的全部本地数据（登录状态、缓存等）。ChatGPT 服务器上的聊天记录不受影响。',
  });
  if (response !== 0 || !win || !tabs.has(id)) {
    return;
  }
  const accountSession = tab.view.webContents.session;
  // Close this account's sign-in popups too.
  for (const window of BrowserWindow.getAllWindows()) {
    if (
      window !== win &&
      !window.isDestroyed() &&
      window.webContents.session === accountSession
    ) {
      window.close();
    }
  }
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  state.profiles = state.profiles.filter(profile => profile.id !== id);
  state.purge.push(id);
  if (state.activeId === id) {
    state.activeId = state.profiles[0]?.id ?? null;
  }
  persist();
  layout();
  buildMenu();
  await wipe(accountSession);
}

function toggleSplit() {
  state.split = !state.split;
  persist();
  layout();
  buildMenu();
}

function goBack() {
  const contents = activeContents();
  if (contents?.navigationHistory.canGoBack()) {
    contents.navigationHistory.goBack();
  }
}

function goForward() {
  const contents = activeContents();
  if (contents?.navigationHistory.canGoForward()) {
    contents.navigationHistory.goForward();
  }
}

function reload() {
  const contents = activeContents();
  if (!contents) {
    return;
  }
  // A page that never got anywhere has nothing to reload.
  if (contents.getURL()) {
    contents.reload();
  } else {
    load(contents, HOME_URL);
  }
}

function goHome() {
  const contents = activeContents();
  if (contents) {
    load(contents, HOME_URL);
  }
}

function zoom(direction) {
  const contents = activeContents();
  if (!contents) {
    return;
  }
  const current = contents.getZoomFactor();
  const next =
    direction === 0
      ? 1
      : direction > 0
        ? ZOOM_STEPS.find(step => step > current + 0.001)
        : ZOOM_STEPS.findLast(step => step < current - 0.001);
  if (next) {
    contents.setZoomFactor(next);
  }
}

function toggleDevTools() {
  const contents = activeContents();
  if (contents?.isDevToolsOpened()) {
    contents.closeDevTools();
  } else {
    contents?.openDevTools({ mode: 'detach' });
  }
}

function showTabMenu(id) {
  const tab = tabs.get(id);
  if (!win || !tab) {
    return;
  }
  Menu.buildFromTemplate([
    { label: '重命名', click: () => beginRename(id) },
    { label: '重新加载', click: () => tab.view.webContents.reload() },
    {
      label: '在默认浏览器中打开当前页面',
      click: () => openExternal(tab.view.webContents.getURL()),
    },
    { type: 'separator' },
    {
      label: '退出登录（清除此标签的数据）…',
      click: () => run(() => signOut(id)),
    },
    { label: '删除此账号标签…', click: () => run(() => removeAccount(id)) },
  ]).popup({ window: win });
}

function showAbout() {
  if (!win) {
    return;
  }
  dialog
    .showMessageBox(win, {
      type: 'info',
      message: `ChatGPT Multi ${app.getVersion()}`,
      detail: `多账号 ChatGPT：每个标签是一个独立的登录环境。\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n数据文件夹：${app.getPath('userData')}`,
    })
    .catch(error => console.error(error));
}

function buildMenu() {
  const accounts = state.profiles.slice(0, 9).map((profile, index) => ({
    label: profile.name,
    accelerator: `CmdOrCtrl+${index + 1}`,
    click: () => activate(profile.id),
  }));
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const appMenu = isMac ? [{ role: 'appMenu' }] : [];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const quit = isMac
    ? []
    : [{ type: 'separator' }, { role: 'quit', label: '退出' }];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const windowMenu = isMac ? [{ role: 'windowMenu', label: '窗口' }] : [];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...appMenu,
    {
      label: '账号',
      submenu: [
        {
          label: '添加账号标签',
          accelerator: 'CmdOrCtrl+T',
          click: addAccount,
        },
        {
          label: '重命名当前账号',
          accelerator: 'F2',
          click: () => beginRename(state.activeId),
        },
        { type: 'separator' },
        ...accounts,
        { label: '下一个标签', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        {
          label: '上一个标签',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => cycle(-1),
        },
        { type: 'separator' },
        {
          label: '退出当前账号的登录…',
          click: () => run(() => signOut(state.activeId)),
        },
        {
          label: '删除当前账号标签…',
          click: () => run(() => removeAccount(state.activeId)),
        },
        ...quit,
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '分屏显示所有账号',
          type: 'checkbox',
          checked: state.split,
          accelerator: 'CmdOrCtrl+Shift+E',
          click: toggleSplit,
        },
        { type: 'separator' },
        {
          label: '返回',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: goBack,
        },
        {
          label: '前进',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: goForward,
        },
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: reload },
        { label: '回到 ChatGPT 首页', click: goHome },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoom(1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(-1) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        {
          label: '开发者工具（当前页面）',
          accelerator: isMac ? 'Alt+Cmd+I' : 'F12',
          click: toggleDevTools,
        },
      ],
    },
    ...windowMenu,
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据文件夹',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { label: '关于 ChatGPT Multi', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function snapshot() {
  const contents = activeContents();
  return {
    platform: process.platform,
    metrics: METRICS,
    split: state.split,
    activeId: state.activeId,
    url: contents?.getURL() ?? '',
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    tabs: state.profiles.map(({ id, name, color }) => {
      const tab = tabs.get(id);
      return {
        id,
        name,
        color,
        title: tab?.title ?? '',
        loading: tab?.loading ?? false,
        failed: tab?.failed ?? false,
      };
    }),
    panes: state.split ? panes.map(({ id, frame }) => ({ id, frame })) : [],
  };
}

// Coalesces the many page events into at most one update per tick.
function pushState() {
  if (statePushQueued) {
    return;
  }
  statePushQueued = true;
  setImmediate(() => {
    statePushQueued = false;
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send('state', snapshot());
    }
  });
}

function registerIpc() {
  const commands = {
    'tab:new': addAccount,
    'tab:select': id => activate(id),
    'tab:rename': renameAccount,
    'tab:close': removeAccount,
    'tab:menu': showTabMenu,
    'nav:back': goBack,
    'nav:forward': goForward,
    'nav:reload': reload,
    'nav:home': goHome,
    'view:split': toggleSplit,
    'page:external': () => openExternal(activeContents()?.getURL()),
    'ui:focus': () => win?.webContents.focus(),
  };
  ipcMain.on('ui', (event, command, ...args) => {
    if (
      !isFromUi(event) ||
      typeof command !== 'string' ||
      !Object.hasOwn(commands, command) ||
      args.length > 2 ||
      !args.every(arg => typeof arg === 'string' && arg.length <= 200)
    ) {
      return;
    }
    run(() => commands[command](...args));
  });
  ipcMain.on('ui-ready', event => {
    if (isFromUi(event)) {
      pushState();
    }
  });
}

// Only the tab strip page may drive the app. Account pages have no preload
// and so no way to send at all; this is defence in depth.
function isFromUi(event) {
  const frame = event.senderFrame;
  return (
    Boolean(win) &&
    event.sender === win.webContents &&
    Boolean(frame) &&
    frame.parent === null &&
    frame.url.startsWith('app://ui/')
  );
}

function run(action) {
  Promise.resolve()
    .then(action)
    .catch(error => console.error(error));
}

function focusWindow() {
  if (!win) {
    if (state) {
      createWindow();
    }
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
}

function persist() {
  try {
    store.save(stateFile, state);
  } catch (error) {
    console.error('Could not save profiles.json:', error);
  }
}

function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0];
  const platform =
    {
      darwin: 'Macintosh; Intel Mac OS X 10_15_7',
      win32: 'Windows NT 10.0; Win64; x64',
    }[process.platform] ?? 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
