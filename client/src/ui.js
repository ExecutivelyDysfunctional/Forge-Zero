/**
 * DOM + formatting helpers. No framework: the workbench has one screen with four
 * regions, and a diffing library would be more code to trust than code to write.
 */

export function h(tag, props = {}, ...children) {
  const [sel, ...rest] = String(tag).split(/(?=[.#])/);
  const el = document.createElement(sel || 'div');
  for (const cls of rest) {
    if (cls[0] === '.') el.classList.add(cls.slice(1));
    else if (cls[0] === '#') el.id = cls.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'open' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const fmt = {
  tokens(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
    return String(n);
  },
  pct(n) { return n == null ? '—' : (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + '%'; },
  ms(n) { return n == null ? '—' : n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's'; },
  bytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; },
  ago(iso) {
    if (!iso) return '—';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  },
  title: (s) => String(s ?? '').replace(/^\w/, (c) => c.toUpperCase()),
};

export const chip = (text, kind = '') => h('span.chip' + (kind ? '.' + kind : ''), { text });

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; a textarea fallback keeps a plain
    // http:// deployment on a LAN working.
    const ta = h('textarea', { value: text, style: 'position:fixed;top:-1000px;left:-1000px' });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function download(name, contents, mime = 'text/plain') {
  const blob = new Blob([contents], { type: mime + '; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastHost = null;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = h('div.toast-host', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div.toast' + (kind ? '.' + kind : ''), { text: message });
  toastHost.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, kind === 'err' ? 6500 : 2800);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3200);
}

export function debounce(fn, ms = 380) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Minimal markdown-ish emphasis for prompt text: ## headings and **bold**. */
export function renderMarkdownish(el, text) {
  el.textContent = '';
  for (const line of String(text).split('\n')) {
    const cls = /^#{1,4}\s/.test(line) ? 'md' : null;
    el.appendChild(h('span', cls ? { class: cls } : {}, line + '\n'));
  }
}

export function gauge(label, value, max, { kind = '', note = null, tickAt = null } = {}) {
  const pct = max ? Math.min(140, Math.round((value / max) * 100)) : 0;
  const bar = h('div.bar' + (kind ? '.' + kind : ''), { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label },
    h('i', { style: `--w:${Math.min(100, pct)}%` }),
    tickAt ? h('span.tick', { style: `left:${tickAt}%` }) : null);
  return h('div.gauge', {},
    h('div.gauge-top', {}, h('span.k', { text: label }), h('span.v', { text: note ?? `${value} / ${max}` })),
    bar);
}
