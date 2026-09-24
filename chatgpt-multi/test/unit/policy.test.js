'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const policy = require('../../src/policy');

describe('navigationDecision', () => {
  const chat = 'https://chatgpt.com/c/123';

  it('keeps ChatGPT, OpenAI and the sign-in providers inside the tab', () => {
    for (const url of [
      'https://chatgpt.com/',
      'https://sora.chatgpt.com/explore',
      'https://auth.openai.com/log-in',
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      'https://gds.google.com/web/chip',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://login.live.com/oauth20_authorize.srf',
      'https://appleid.apple.com/auth/authorize',
    ]) {
      assert.equal(policy.navigationDecision(url, chat), 'allow', url);
    }
  });

  it('sends every other website to the system browser', () => {
    for (const url of [
      'https://example.com/',
      'https://evilchatgpt.com/',
      'https://chatgpt.com.evil.example/',
      'https://openai.com.evil.example/',
      'http://chatgpt.com/',
    ]) {
      assert.equal(policy.navigationDecision(url, chat), 'external', url);
    }
  });

  it('blocks schemes that could reach local files or programs', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'blob:https://chatgpt.com/abc',
      'smb://server/share',
      'ms-settings:',
      'not a url',
    ]) {
      assert.equal(policy.navigationDecision(url, chat), 'block', url);
    }
  });

  it('lets a company sign-in page hop across its own domains', () => {
    assert.equal(
      policy.navigationDecision(
        'https://sso.example-corp.net/mfa',
        'https://example-corp.okta.com/login',
      ),
      'allow',
    );
  });

  it('does not extend that freedom to known domains or blank popups', () => {
    for (const current of [
      'https://accounts.google.com/',
      'https://chatgpt.com/',
      'about:blank',
      '',
    ]) {
      assert.equal(
        policy.navigationDecision('https://example.com/', current),
        'external',
        current,
      );
    }
  });
});

describe('windowOpenDecision', () => {
  it('opens sign-in and ChatGPT popups inside the account', () => {
    for (const url of [
      'about:blank',
      'https://chatgpt.com/share/abc',
      'https://auth.openai.com/authorize',
      'https://accounts.google.com/o/oauth2/auth?client_id=1',
      'https://login.microsoftonline.com/common/oauth2/authorize',
      'https://github.com/login/oauth/authorize?redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Fcallback',
    ]) {
      assert.equal(policy.windowOpenDecision(url), 'popup', url);
    }
  });

  it('hands ordinary links to the system browser', () => {
    for (const url of [
      'https://example.com/article',
      'https://www.google.com/search?q=electron',
      'https://help.openai.com/en/articles/1',
      'https://github.com/login/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2F',
      'http://chatgpt.com/',
    ]) {
      assert.equal(policy.windowOpenDecision(url), 'external', url);
    }
  });

  it('refuses anything that is not a web page', () => {
    for (const url of [
      'file:///C:/Windows/',
      'javascript:alert(1)',
      'mailto:a@b.c',
    ]) {
      assert.equal(policy.windowOpenDecision(url), 'deny', url);
    }
  });
});

describe('redirectAllowed', () => {
  it('allows HTTPS redirects only', () => {
    assert.equal(policy.redirectAllowed('https://sso.example-corp.net/'), true);
    assert.equal(policy.redirectAllowed('http://chatgpt.com/'), false);
    assert.equal(policy.redirectAllowed('file:///etc/passwd'), false);
  });
});

describe('isPermissionAllowed', () => {
  const chat = 'https://chatgpt.com/';

  it('grants ChatGPT clipboard writes, notifications and the microphone', () => {
    assert.equal(
      policy.isPermissionAllowed('clipboard-sanitized-write', chat),
      true,
    );
    assert.equal(policy.isPermissionAllowed('notifications', chat), true);
    assert.equal(policy.isPermissionAllowed('media', chat, ['audio']), true);
  });

  it('refuses the camera, screen, location and clipboard reads', () => {
    assert.equal(policy.isPermissionAllowed('media', chat, ['video']), false);
    assert.equal(
      policy.isPermissionAllowed('media', chat, ['audio', 'video']),
      false,
    );
    assert.equal(policy.isPermissionAllowed('media', chat, []), false);
    assert.equal(policy.isPermissionAllowed('media', chat), false);
    for (const permission of [
      'display-capture',
      'geolocation',
      'clipboard-read',
      'openExternal',
      'hid',
      'usb',
      'serial',
      'fullscreen',
    ]) {
      assert.equal(
        policy.isPermissionAllowed(permission, chat),
        false,
        permission,
      );
    }
  });

  it('refuses every other origin, including look-alikes', () => {
    for (const origin of [
      'https://example.com/',
      'https://auth.openai.com/',
      'https://chatgpt.com.evil.example/',
      'http://chatgpt.com/',
      '',
      undefined,
    ]) {
      assert.equal(
        policy.isPermissionAllowed('notifications', origin),
        false,
        String(origin),
      );
    }
  });
});

describe('isSafeExternalUrl', () => {
  it('only accepts http and https', () => {
    assert.equal(policy.isSafeExternalUrl('https://example.com/'), true);
    assert.equal(policy.isSafeExternalUrl('http://example.com/'), true);
    for (const url of [
      'file:///etc/passwd',
      'smb://host/share',
      'javascript:alert(1)',
      'vscode://file/x',
      'mailto:a@b.c',
      '',
      null,
    ]) {
      assert.equal(policy.isSafeExternalUrl(url), false, String(url));
    }
  });
});

describe('sanitizeName', () => {
  it('trims and collapses whitespace', () => {
    assert.equal(policy.sanitizeName('  工作   号 \n'), '工作 号');
  });

  it('removes invisible and direction-changing characters', () => {
    assert.equal(policy.sanitizeName('A\u202Egnp.exe\u200B'), 'Agnp.exe');
    assert.equal(policy.sanitizeName('\u0000\u0007'), null);
  });

  it('limits the length by characters, not bytes', () => {
    const name = policy.sanitizeName('号'.repeat(50));
    assert.equal([...name].length, policy.MAX_NAME_LENGTH);
  });

  it('rejects empty and non-string values', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(policy.sanitizeName(value), null);
    }
  });
});
