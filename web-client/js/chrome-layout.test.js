const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromeLayout } = require('./chrome-layout.js');

test('syncChromeTop writes pixel height to --chrome-top', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(223, root);
  assert.equal(root.style['--chrome-top'], '223px');
});

test('syncChromeTop ignores non-positive heights', () => {
  const root = { style: { setProperty(name, value) { this[name] = value; } } };
  ChromeLayout.syncChromeTop(0, root);
  assert.equal(root.style['--chrome-top'], undefined);
});

test('toggleMoreMenu sets hidden and aria-expanded', () => {
  const next = ChromeLayout.nextMoreMenuState(false);
  assert.equal(next.open, true);
  assert.equal(ChromeLayout.nextMoreMenuState(true).open, false);
  assert.equal(typeof ChromeLayout.toggleMoreMenu, 'function');
});

test('revealViewerChrome clears hidden and idle and shows the fab only when docks are away', () => {
  const classes = new Set(['stream-connected', 'controls-hidden', 'chrome-idle']);
  const fab = { hidden: true };
  const root = {
    body: {
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => { classes.add(name); },
        remove: (name) => { classes.delete(name); },
      },
    },
    getElementById: (id) => (id === 'showControlsFab' ? fab : null),
  };
  ChromeLayout.syncShowControlsFab(root);
  assert.equal(fab.hidden, false);
  ChromeLayout.revealViewerChrome(root);
  assert.equal(classes.has('controls-hidden'), false);
  assert.equal(classes.has('chrome-idle'), false);
  assert.equal(fab.hidden, true);
});

function createMoreMenuDom() {
  const ids = {};
  const match = (el, selector) => {
    if (selector === '.action-bar') return /\baction-bar\b/.test(el.className);
    if (selector === '.action-more' || selector === '#moreActionsBtn') {
      return el.id === 'moreActionsBtn' || /\baction-more\b/.test(el.className);
    }
    if (selector === '#moreActionsMenu') return el.id === 'moreActionsMenu';
    if (selector === '.action-btn') return /\baction-btn\b/.test(el.className);
    if (selector === '.action-btn:not(.action-more)') {
      return /\baction-btn\b/.test(el.className) && !/\baction-more\b/.test(el.className);
    }
    if (selector === '.action-btn:not(.action-more):not([data-pin="always"])') {
      return /\baction-btn\b/.test(el.className)
        && !/\baction-more\b/.test(el.className)
        && el.attrs['data-pin'] !== 'always';
    }
    return false;
  };
  const el = (className, attrs = {}, id = '') => {
    const node = {
      id,
      className,
      attrs: { ...attrs },
      hidden: !!attrs.hidden,
      children: [],
      parent: null,
      classList: {
        contains(name) {
          return new Set(node.className.split(/\s+/).filter(Boolean)).has(name);
        },
        toggle(name, on) {
          const set = new Set(node.className.split(/\s+/).filter(Boolean));
          if (on) set.add(name); else set.delete(name);
          node.className = [...set].join(' ');
        },
      },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      querySelectorAll(selector) {
        const found = [];
        const walk = (current) => {
          current.children.forEach((child) => {
            if (match(child, selector)) found.push(child);
            walk(child);
          });
        };
        walk(this);
        return found;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = this;
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
      },
    };
    if (id) ids[id] = node;
    return node;
  };

  const body = el('body');
  const bar = el('action-bar');
  const labels = ['enter', 'up', 'down', 'keyboard', 'copy'];
  const buttons = labels.map((name) => {
    const attrs = name === 'enter' || name === 'keyboard' ? { 'data-pin': 'always' } : {};
    const button = el('action-btn', attrs, name === 'keyboard' ? 'keyboardModeBtn' : '');
    button.name = name;
    bar.appendChild(button);
    return button;
  });
  const more = el('action-btn action-more', { 'aria-expanded': 'false' }, 'moreActionsBtn');
  const menu = el('more-actions-menu', { hidden: true }, 'moreActionsMenu');
  bar.appendChild(more);
  bar.appendChild(menu);
  body.appendChild(bar);
  const root = {
    body,
    getElementById: (id) => ids[id] || null,
    querySelector: (selector) => (match(bar, selector) ? bar : body.querySelector(selector)),
  };
  return { root, bar, more, menu, buttons };
}

test('toggleMoreMenu moves overflow nodes and restores original order', () => {
  const { root, bar, more, menu, buttons } = createMoreMenuDom();
  const names = () => bar.children.filter((child) => /\baction-btn\b/.test(child.className)).map((child) => child.name || 'more');

  ChromeLayout.recordOverflowHomeIndexes(bar);
  assert.equal(buttons[1].getAttribute('data-home-index'), '1');
  assert.equal(buttons[2].getAttribute('data-home-index'), '2');
  assert.equal(buttons[4].getAttribute('data-home-index'), '4');
  assert.equal(buttons[0].getAttribute('data-home-index'), null);

  const opened = ChromeLayout.toggleMoreMenu(true, root);
  assert.equal(opened.open, true);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.hidden, false);
  assert.match(root.body.className, /\bmore-open\b/);
  assert.deepEqual(names(), ['enter', 'keyboard', 'more']);
  assert.deepEqual(menu.children.map((child) => child.name), ['up', 'down', 'copy']);

  const closed = ChromeLayout.toggleMoreMenu(false, root);
  assert.equal(closed.open, false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.hidden, true);
  assert.equal(menu.children.length, 0);
  assert.deepEqual(names(), ['enter', 'up', 'down', 'keyboard', 'copy', 'more']);
});

test('shouldIdle only when streaming, chrome visible, idle long enough', () => {
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2500,
  }), true);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 2499,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: false, controlsHidden: false, menuOpen: false, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: true, modalOpen: false, idleMs: 5000,
  }), false);
  assert.equal(ChromeLayout.shouldIdle({
    streamConnected: true, controlsHidden: false, menuOpen: false, modalOpen: true, idleMs: 5000,
  }), false);
});
