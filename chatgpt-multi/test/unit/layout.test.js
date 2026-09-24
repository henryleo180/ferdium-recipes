'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { METRICS, computeLayout } = require('../../src/layout');

const ids = ['a', 'b', 'c', 'd', 'e'];

function overlaps(one, other) {
  return (
    one.x < other.x + other.width &&
    other.x < one.x + one.width &&
    one.y < other.y + other.height &&
    other.y < one.y + one.height
  );
}

function assertSane(panes, width, height) {
  for (const { frame, view } of panes) {
    for (const rect of [frame, view]) {
      for (const value of Object.values(rect)) {
        assert.ok(Number.isInteger(value) && value >= 0, JSON.stringify(rect));
      }
      assert.ok(rect.x + rect.width <= width, 'fits horizontally');
      assert.ok(rect.y + rect.height <= height, 'fits vertically');
      assert.ok(rect.y >= METRICS.toolbarHeight, 'stays below the toolbar');
    }
    assert.ok(view.x >= frame.x && view.y >= frame.y, 'view inside its frame');
  }
  for (const [index, pane] of panes.entries()) {
    for (const other of panes.slice(index + 1)) {
      assert.ok(!overlaps(pane.frame, other.frame), 'panes do not overlap');
    }
  }
}

describe('single view', () => {
  it('fills the window below the toolbar with the active account', () => {
    const panes = computeLayout({
      width: 1280,
      height: 860,
      ids,
      activeId: 'c',
      split: false,
    });
    const area = {
      x: 0,
      y: METRICS.toolbarHeight,
      width: 1280,
      height: 860 - METRICS.toolbarHeight,
    };
    assert.deepEqual(panes, [{ id: 'c', frame: area, view: area }]);
  });

  it('shows nothing without a valid active account', () => {
    assert.deepEqual(
      computeLayout({
        width: 800,
        height: 600,
        ids,
        activeId: null,
        split: false,
      }),
      [],
    );
    assert.deepEqual(
      computeLayout({
        width: 800,
        height: 600,
        ids: [],
        activeId: 'a',
        split: true,
      }),
      [],
    );
  });

  it('falls back to a single view when there is only one account', () => {
    const panes = computeLayout({
      width: 800,
      height: 600,
      ids: ['a'],
      activeId: 'a',
      split: true,
    });
    assert.equal(panes.length, 1);
  });
});

describe('split view', () => {
  it('puts two accounts side by side', () => {
    const panes = computeLayout({
      width: 1280,
      height: 860,
      ids: ['a', 'b'],
      activeId: 'a',
      split: true,
    });
    assert.equal(panes.length, 2);
    const [left, right] = panes;
    assert.equal(left.frame.y, right.frame.y);
    assert.equal(left.frame.width, right.frame.width);
    assert.ok(left.frame.x < right.frame.x);
    assert.equal(
      right.frame.x - (left.frame.x + left.frame.width),
      METRICS.paneGap,
    );
    assert.equal(left.view.y - left.frame.y, METRICS.paneHeader);
    assertSane(panes, 1280, 860);
  });

  it('uses a 2x2 grid for four accounts and 3 columns for five', () => {
    const four = computeLayout({
      width: 1280,
      height: 860,
      ids: ids.slice(0, 4),
      activeId: 'a',
      split: true,
    });
    assert.equal(new Set(four.map(pane => pane.frame.y)).size, 2);
    assert.equal(new Set(four.map(pane => pane.frame.x)).size, 2);
    assertSane(four, 1280, 860);

    const five = computeLayout({
      width: 1280,
      height: 860,
      ids,
      activeId: 'a',
      split: true,
    });
    assert.equal(new Set(five.map(pane => pane.frame.x)).size, 3);
    assertSane(five, 1280, 860);
  });

  it('stays valid in a tiny window', () => {
    const panes = computeLayout({
      width: 30,
      height: 50,
      ids,
      activeId: 'a',
      split: true,
    });
    assertSane(panes, 30, 50);
  });
});
