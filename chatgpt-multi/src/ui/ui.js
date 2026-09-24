'use strict';

// The tab strip. It only renders what the main process sends and forwards
// clicks back; all decisions are made in the main process.

const api = window.chatgptMulti;
const root = document.documentElement;
const tabList = document.querySelector('#tabs');
const stage = document.querySelector('#stage');
const address = document.querySelector('#address');
const host = document.querySelector('#host');
const empty = document.querySelector('#empty');

const buttonCommands = {
  back: 'nav:back',
  forward: 'nav:forward',
  reload: 'nav:reload',
  home: 'nav:home',
  add: 'tab:new',
  split: 'view:split',
  external: 'page:external',
  'empty-add': 'tab:new',
};
const buttons = {};
for (const [id, command] of Object.entries(buttonCommands)) {
  buttons[id] = document.querySelector(`#${id}`);
  buttons[id].addEventListener('click', () => api.send(command));
}

const CLOSE_ICON =
  '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>';
const FIRST_PARTY = /(^|\.)(chatgpt\.com|openai\.com)$/;

let state = null;
let renaming = null;
let pendingRename = null;

api.onState(next => {
  state = next;
  render();
});
api.onBeginRename(id => {
  pendingRename = id;
  if (state) {
    startPendingRename();
  }
});
api.ready();

function render() {
  const { metrics } = state;
  root.style.setProperty('--toolbar-height', `${metrics.toolbarHeight}px`);
  root.style.setProperty('--pane-header', `${metrics.paneHeader}px`);
  root.style.setProperty('--pane-border', `${metrics.paneBorder}px`);
  document.body.dataset.platform = state.platform;
  renderTabs();
  renderToolbar();
  renderPanes();
  empty.hidden = state.tabs.length > 0;
  startPendingRename();
}

function shortcutPrefix() {
  return state.platform === 'darwin' ? '⌘' : 'Ctrl+';
}

function findTab(id) {
  return [...tabList.children].find(element => element.dataset.id === id);
}

function renderTabs() {
  const existing = new Map(
    [...tabList.children].map(element => [element.dataset.id, element]),
  );
  for (const [index, tab] of state.tabs.entries()) {
    const element = existing.get(tab.id) ?? createTab(tab.id);
    existing.delete(tab.id);
    if (tabList.children[index] !== element) {
      tabList.insertBefore(element, tabList.children[index] ?? null);
    }
    updateTab(element, tab, index);
  }
  for (const element of existing.values()) {
    element.remove();
  }
  if (renaming && !findTab(renaming)) {
    renaming = null;
  }
}

function createTab(id) {
  const element = document.createElement('div');
  element.className = 'tab';
  element.dataset.id = id;
  element.setAttribute('role', 'tab');

  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'name';
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.title = '删除此账号标签';
  close.setAttribute('aria-label', '删除此账号标签');
  close.innerHTML = CLOSE_ICON;
  element.append(dot, name, close);

  element.addEventListener('click', event => {
    if (!event.target.closest('.close, .rename')) {
      api.send('tab:select', id);
    }
  });
  element.addEventListener('dblclick', event => {
    if (!event.target.closest('.close, .rename')) {
      startRename(id);
    }
  });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    api.send('tab:menu', id);
  });
  close.addEventListener('click', () => api.send('tab:close', id));
  return element;
}

function updateTab(element, tab, index) {
  const active = tab.id === state.activeId;
  element.classList.toggle('active', active);
  element.classList.toggle('loading', tab.loading);
  element.classList.toggle('failed', tab.failed);
  element.setAttribute('aria-selected', String(active));
  element.style.setProperty('--account', tab.color);
  const shortcut = index < 9 ? `（${shortcutPrefix()}${index + 1}）` : '';
  const status = tab.failed ? '页面加载失败，点刷新按钮重试' : tab.title;
  element.title = `${tab.name}${shortcut}${status ? `\n${status}` : ''}\n双击重命名，右键更多操作`;
  if (renaming !== tab.id) {
    element.querySelector('.name').textContent = tab.name;
  }
}

function startPendingRename() {
  if (pendingRename && startRename(pendingRename)) {
    pendingRename = null;
  }
}

// Returns false while the tab is not on screen yet, so it can be retried.
function startRename(id) {
  const element = findTab(id);
  if (!element) {
    return false;
  }
  if (renaming) {
    return true;
  }
  renaming = id;
  // Keyboard focus may be in an account page: take it back for the input.
  api.send('ui:focus');

  const name = element.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = name.textContent;
  input.maxLength = 32;
  input.spellcheck = false;
  input.setAttribute('aria-label', '账号名称');
  name.hidden = true;
  name.after(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit, backToPage) => {
    if (finished) {
      return;
    }
    finished = true;
    renaming = null;
    const value = input.value.trim();
    input.remove();
    name.hidden = false;
    if (commit && value && value !== name.textContent) {
      name.textContent = value;
      api.send('tab:rename', id, value);
    }
    if (backToPage) {
      api.send('tab:select', id);
    }
    if (state) {
      render();
    }
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    // Enter also confirms Chinese/Japanese input candidates: leave that alone.
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Enter') {
      finish(true, true);
    } else if (event.key === 'Escape') {
      finish(false, true);
    }
  });
  input.addEventListener('blur', () => finish(true, false));
  return true;
}

function renderToolbar() {
  const hasTabs = state.tabs.length > 0;
  buttons.back.disabled = !state.canGoBack;
  buttons.forward.disabled = !state.canGoForward;
  buttons.reload.disabled = !hasTabs;
  buttons.home.disabled = !hasTabs;
  buttons.external.disabled = !/^https?:/.test(state.url);
  buttons.split.disabled = state.tabs.length < 2;
  buttons.split.setAttribute('aria-pressed', String(state.split));

  let url = null;
  try {
    url = new URL(state.url);
  } catch {
    // No page yet.
  }
  address.hidden = !url || !/^https?:$/.test(url.protocol);
  if (!address.hidden) {
    const thirdParty = !FIRST_PARTY.test(url.hostname);
    host.textContent = url.host + (url.pathname === '/' ? '' : url.pathname);
    address.title = thirdParty
      ? `注意：当前是第三方网站 ${url.host}\n${state.url}`
      : state.url;
    address.classList.toggle('third-party', thirdParty);
    address.classList.toggle('insecure', url.protocol !== 'https:');
  }
}

function renderPanes() {
  const existing = new Map(
    [...stage.querySelectorAll('.pane')].map(element => [
      element.dataset.id,
      element,
    ]),
  );
  const tabsById = new Map(state.tabs.map(tab => [tab.id, tab]));
  for (const { id, frame } of state.panes) {
    const tab = tabsById.get(id);
    if (!tab) {
      continue;
    }
    const element = existing.get(id) ?? createPane(id);
    existing.delete(id);
    Object.assign(element.style, {
      left: `${frame.x}px`,
      top: `${frame.y}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
    });
    element.style.setProperty('--account', tab.color);
    element.classList.toggle('active', id === state.activeId);
    element.querySelector('.pane-name').textContent = tab.name;
    element.querySelector('.pane-title').textContent = tab.failed
      ? '加载失败'
      : tab.title;
  }
  for (const element of existing.values()) {
    element.remove();
  }
}

function createPane(id) {
  const element = document.createElement('div');
  element.className = 'pane';
  element.dataset.id = id;
  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'pane-name';
  const title = document.createElement('span');
  title.className = 'pane-title';
  header.append(dot, name, title);
  element.append(header);
  header.addEventListener('click', () => api.send('tab:select', id));
  header.addEventListener('contextmenu', event => {
    event.preventDefault();
    api.send('tab:menu', id);
  });
  stage.append(element);
  return element;
}
