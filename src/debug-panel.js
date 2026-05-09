const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STORAGE_KEY = 'gjs:debug-visible';

function setupToggle(root) {
  const btn = document.getElementById('debug-toggle');
  const layout = document.getElementById('layout');
  if (!btn) return;
  btn.hidden = false;

  const stored = localStorage.getItem(STORAGE_KEY);
  let visible = stored === null ? true : stored === '1';

  const apply = () => {
    root.classList.toggle('hidden', !visible);
    layout?.classList.toggle('debug-hidden', !visible);
    btn.firstChild.nodeValue = visible ? 'Hide debug' : 'Show debug';
    localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
  };

  const toggle = () => {
    visible = !visible;
    apply();
  };

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (e.key === '`' || e.key === '~') {
      e.preventDefault();
      toggle();
    }
  });

  apply();
}

export function mountDebugPanel(game) {
  const root = document.getElementById('debug');
  if (!root) return;
  setupToggle(root);

  const heldKeys = new Set();
  const lastPressed = { key: null, at: 0 };

  window.addEventListener('keydown', (e) => {
    heldKeys.add(e.key);
    lastPressed.key = e.key;
    lastPressed.at = performance.now();
  });
  window.addEventListener('keyup', (e) => heldKeys.delete(e.key));
  window.addEventListener('blur', () => heldKeys.clear());

  const resources = new Map();
  const recordEntry = (e) => {
    if (!e.name) return;
    resources.set(e.name, {
      size: e.transferSize || e.encodedBodySize || 0,
      decoded: e.decodedBodySize || 0,
      type: e.initiatorType || 'other',
      duration: e.duration || 0,
    });
  };
  performance.getEntriesByType('resource').forEach(recordEntry);
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(recordEntry)).observe({
      type: 'resource',
      buffered: true,
    });
  } catch {}

  const sections = {
    runtime: section('Runtime'),
    keys: section('Keys'),
    storage: section('Storage'),
    bundle: section('Bundle / Network'),
    assets: section('Phaser assets'),
    env: section('Environment'),
  };
  for (const s of Object.values(sections)) root.appendChild(s.el);

  function section(title) {
    const el = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    const body = document.createElement('div');
    el.appendChild(body);
    return { el, body };
  }

  function rows(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `<div class="row"><span class="k">${escape(k)}</span><span class="v">${escape(v)}</span></div>`)
      .join('');
  }

  function readCookies() {
    if (!document.cookie) return [];
    return document.cookie.split(';').map((c) => {
      const [k, ...rest] = c.trim().split('=');
      return { k, v: rest.join('=') };
    });
  }

  function readStorage(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      out.push({ k, v: s.getItem(k) });
    }
    return out;
  }

  function listBlock(items, fmt, emptyLabel = 'empty') {
    if (!items.length) return `<div class="empty">${emptyLabel}</div>`;
    return `<div class="list">${items.map(fmt).join('')}</div>`;
  }

  function totalBundle() {
    let total = 0;
    let count = 0;
    let byType = {};
    for (const r of resources.values()) {
      total += r.size;
      count++;
      byType[r.type] = (byType[r.type] || 0) + r.size;
    }
    return { total, count, byType };
  }

  function getActiveScene() {
    const scenes = game.scene?.getScenes(true) || [];
    return scenes.map((s) => s.scene.key).join(', ') || '—';
  }

  function getTextures() {
    const list = [];
    const tm = game.textures;
    if (!tm) return list;
    tm.each((tex) => {
      if (tex.key === '__DEFAULT' || tex.key === '__MISSING' || tex.key === '__WHITE') return;
      const src = tex.source[0];
      list.push({
        key: tex.key,
        w: src?.width || 0,
        h: src?.height || 0,
        frames: tex.frameTotal || 0,
      });
    });
    return list;
  }

  function getAudio() {
    const cache = game.cache?.audio;
    if (!cache) return [];
    return cache.getKeys().map((k) => ({ key: k }));
  }

  function render() {
    const fps = game.loop?.actualFps || 0;
    const target = game.loop?.targetFps || 60;
    const mem = performance.memory;

    sections.runtime.body.innerHTML = rows({
      fps: `${fps.toFixed(1)} / ${target}`,
      delta: `${(game.loop?.delta || 0).toFixed(1)} ms`,
      time: `${(game.loop?.time / 1000 || 0).toFixed(1)} s`,
      scene: getActiveScene(),
      canvas: `${game.canvas?.width || 0}×${game.canvas?.height || 0}`,
      renderer: game.renderer?.type === 1 ? 'Canvas' : 'WebGL',
      ...(mem
        ? {
            'js heap': fmtBytes(mem.usedJSHeapSize),
            'heap limit': fmtBytes(mem.jsHeapSizeLimit),
          }
        : {}),
    });

    const keysHtml = Array.from(heldKeys)
      .map((k) => `<span class="key held">${escape(k)}</span>`)
      .join('');
    const lastHtml =
      lastPressed.key && performance.now() - lastPressed.at < 600
        ? `<span class="key">${escape(lastPressed.key)}</span>`
        : '';
    sections.keys.body.innerHTML = `
      <div class="row"><span class="k">held</span><span class="v">${heldKeys.size}</span></div>
      <div class="keys">${keysHtml || `<span class="empty">no keys held</span>`}</div>
      <div class="row" style="margin-top:6px"><span class="k">last pressed</span><span class="v"></span></div>
      <div class="keys">${lastHtml || `<span class="empty">—</span>`}</div>
    `;

    const cookies = readCookies();
    const ls = readStorage(localStorage);
    const ss = readStorage(sessionStorage);
    sections.storage.body.innerHTML = `
      <div class="row"><span class="k">cookies</span><span class="v">${cookies.length}</span></div>
      ${listBlock(
        cookies,
        (c) =>
          `<div class="item"><span class="name">${escape(c.k)}</span><span class="meta">${escape(
            c.v.slice(0, 24),
          )}${c.v.length > 24 ? '…' : ''}</span></div>`,
        'no cookies',
      )}
      <div class="row" style="margin-top:8px"><span class="k">localStorage</span><span class="v">${ls.length}</span></div>
      ${listBlock(
        ls,
        (e) =>
          `<div class="item"><span class="name">${escape(e.k)}</span><span class="meta">${fmtBytes(
            (e.v || '').length,
          )}</span></div>`,
        'empty',
      )}
      <div class="row" style="margin-top:8px"><span class="k">sessionStorage</span><span class="v">${ss.length}</span></div>
      ${listBlock(
        ss,
        (e) =>
          `<div class="item"><span class="name">${escape(e.k)}</span><span class="meta">${fmtBytes(
            (e.v || '').length,
          )}</span></div>`,
        'empty',
      )}
    `;

    const b = totalBundle();
    const typeRows = Object.entries(b.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, v]) => `<span class="pill">${escape(t)} ${fmtBytes(v)}</span>`)
      .join('');
    const top5 = [...resources.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 6)
      .map(([url, r]) => {
        const name = url.split('/').pop().split('?')[0] || url;
        return `<div class="item"><span class="name" title="${escape(url)}">${escape(name)}</span><span class="meta">${fmtBytes(
          r.size,
        )}</span></div>`;
      })
      .join('');
    sections.bundle.body.innerHTML = `
      <div class="row"><span class="k">requests</span><span class="v">${b.count}</span></div>
      <div class="row"><span class="k">total xfer</span><span class="v">${fmtBytes(b.total)}</span></div>
      <div style="margin:6px 0">${typeRows}</div>
      <div class="list">${top5 || '<div class="empty">no resources</div>'}</div>
    `;

    const tex = getTextures();
    const audio = getAudio();
    sections.assets.body.innerHTML = `
      <div class="row"><span class="k">textures</span><span class="v">${tex.length}</span></div>
      ${listBlock(
        tex,
        (t) =>
          `<div class="item"><span class="name">${escape(t.key)}</span><span class="meta">${t.w}×${t.h}${
            t.frames > 1 ? ` · ${t.frames}f` : ''
          }</span></div>`,
        'no textures loaded',
      )}
      <div class="row" style="margin-top:8px"><span class="k">audio</span><span class="v">${audio.length}</span></div>
      ${listBlock(
        audio,
        (a) => `<div class="item"><span class="name">${escape(a.key)}</span><span class="meta">cached</span></div>`,
        'no audio loaded',
      )}
    `;

    sections.env.body.innerHTML = rows({
      mode: import.meta.env.MODE,
      'user agent': navigator.userAgent.split(' ').slice(-2).join(' '),
      lang: navigator.language,
      online: navigator.onLine ? 'yes' : 'no',
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      dpr: window.devicePixelRatio,
    });
  }

  render();
  setInterval(render, 250);
}
