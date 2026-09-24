'use strict';

// Decides where an account tab may go and what it may do. Kept free of
// Electron imports so it can be unit tested with plain Node.

// ChatGPT itself. Only these pages get the few permissions ChatGPT needs.
const CHATGPT_DOMAINS = ['chatgpt.com'];
// OpenAI's own sign-in pages.
const OPENAI_AUTH_HOSTS = ['auth.openai.com', 'auth0.openai.com'];
// Exact hosts of the third-party sign-in options on the ChatGPT login page.
// Popups to them stay inside the account so the login lands in the right tab.
const SIGN_IN_HOSTS = [
  'accounts.google.com',
  'login.live.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
];
// Domains (subdomains included) a login flow may walk through inside a tab.
const TAB_DOMAINS = [
  ...CHATGPT_DOMAINS,
  'openai.com',
  'google.com',
  'live.com',
  'microsoftonline.com',
  'microsoft.com',
  'apple.com',
];
// Query parameters OAuth providers use for the address they send you back to.
const RETURN_PARAMS = [
  'redirect_uri',
  'redirect_url',
  'return_to',
  'returnTo',
  'callback_url',
];

// Copy buttons, voice input and ChatGPT's own notifications. Everything else
// (camera, location, screen capture, USB, clipboard reading...) is refused.
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'media',
  'notifications',
]);

// Invisible and direction-changing characters that could disguise a name.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const MAX_NAME_LENGTH = 32;

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function hostMatches(hostname, domains) {
  return domains.some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

/**
 * @param {URL | null} url
 * @returns {url is URL}
 */
function isHttps(url) {
  return url?.protocol === 'https:';
}

/**
 * @param {URL | null} url
 * @returns {url is URL}
 */
function isWeb(url) {
  return url?.protocol === 'https:' || url?.protocol === 'http:';
}

function isChatGptSide(url) {
  return (
    isHttps(url) &&
    (hostMatches(url.hostname, CHATGPT_DOMAINS) ||
      OPENAI_AUTH_HOSTS.includes(url.hostname))
  );
}

function returnsToChatGpt(url) {
  return RETURN_PARAMS.some(key =>
    isChatGptSide(parseUrl(url.searchParams.get(key))),
  );
}

// Only ever hand plain web links to the system browser: other schemes
// (file:, smb:, custom app protocols...) can launch local programs.
function isSafeExternalUrl(value) {
  return isWeb(parseUrl(value));
}

// A page is navigating its own tab (link click, form post, location change).
// Returns 'allow', 'external' (open in the system browser instead) or 'block'.
function navigationDecision(targetUrl, currentUrl) {
  const target = parseUrl(targetUrl);
  if (!isWeb(target)) {
    return 'block';
  }
  if (isHttps(target)) {
    if (hostMatches(target.hostname, TAB_DOMAINS)) {
      return 'allow';
    }
    // Pages outside the known domains are only reached through a server
    // redirect during sign-in (e.g. a company SSO page), and such flows may
    // hop across the provider's own domains.
    const current = parseUrl(currentUrl);
    if (isHttps(current) && !hostMatches(current.hostname, TAB_DOMAINS)) {
      return 'allow';
    }
  }
  return 'external';
}

// window.open() or a target="_blank" link. Returns 'popup' (a child window
// sharing the account's session), 'external' or 'deny'.
function windowOpenDecision(targetUrl) {
  if (targetUrl === 'about:blank') {
    return 'popup';
  }
  const target = parseUrl(targetUrl);
  if (!isWeb(target)) {
    return 'deny';
  }
  if (
    isChatGptSide(target) ||
    (isHttps(target) && SIGN_IN_HOSTS.includes(target.hostname)) ||
    (isHttps(target) && returnsToChatGpt(target))
  ) {
    return 'popup';
  }
  return 'external';
}

// Server-side redirects are allowed anywhere, as long as they stay on HTTPS.
function redirectAllowed(targetUrl) {
  return isHttps(parseUrl(targetUrl));
}

function isPermissionAllowed(permission, requestingUrl, mediaTypes) {
  const origin = parseUrl(requestingUrl);
  if (!isHttps(origin) || !hostMatches(origin.hostname, CHATGPT_DOMAINS)) {
    return false;
  }
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    return false;
  }
  if (permission === 'media') {
    // Microphone only.
    return (
      Array.isArray(mediaTypes) &&
      mediaTypes.length > 0 &&
      mediaTypes.every(type => type === 'audio')
    );
  }
  return true;
}

// Account names come from the tab strip; returns null when nothing usable is left.
function sanitizeName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const clean = value
    .replace(HIDDEN_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    return null;
  }
  return [...clean].slice(0, MAX_NAME_LENGTH).join('').trim();
}

module.exports = {
  MAX_NAME_LENGTH,
  hostMatches,
  isPermissionAllowed,
  isSafeExternalUrl,
  navigationDecision,
  redirectAllowed,
  sanitizeName,
  windowOpenDecision,
};
