/* Module 36 — THE UI KIT (themed dropdowns, calendar, dialogs, tooltips, chrome).
   Two kinds of page are driven:
     · a bare page with ONLY the kit loaded (no ERP at all) — this proves the kit is host-agnostic,
       which is what lets the Warehouse app use the same file;
     · the real built ERP, for the call sites that used to call confirm() / prompt().
   jsdom does no layout and draws no CSS, so this proves BEHAVIOUR: what opens, what is
   chosen, which events fire, where focus goes, what is refused. How it looks was checked in a
   real Chrome (light and dark, desktop and phone width). */
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import { webcrypto } from 'crypto';

const KIT = fs.readFileSync('36-ui-kit.js', 'utf8');
const ERP_HTML = fs.readFileSync('dist/farooq-co-erp.html', 'utf8');
const PWA_HTML = fs.readFileSync('dist/farooq-co-warehouse-pwa.html', 'utf8');
const LAUNCHER = fs.readFileSync('dist/index.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) { pass++; out.push('  ✔ ' + n); } else { fail++; out.push('  ✘ ' + n + (d ? '   → ' + d : '')); } };
const errors = [];
let finished = false;
/* a promise that never settles would let node exit 0 with nothing printed — never let that pass */
process.on('exit', () => {
  if (finished) return;
  console.log(out.join('\n'));
  console.log('\nINCOMPLETE: the run stopped before its last check (a promise never settled)');
  process.exitCode = 3;
});
const nativeLike = () => function () {}.bind(null);          // toString() → "function () { [native code] }"
const mm = (hover) => q => ({ media: q, matches: hover ? /hover: hover/.test(q) : false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

/* ── a bare page with just the kit ── */
function kitPage({ hover = false, native = true } = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'https://x.local/' });
  const w = dom.window;
  w.matchMedia = mm(hover);
  if (native) { for (const k of ['alert', 'confirm', 'prompt']) Object.defineProperty(w, k, { value: nativeLike(), configurable: true, writable: true }); }
  w.eval(KIT);
  return w;
}
/* ── the real ERP ── */
function appPage(store) {
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(ERP_HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://erp.farooqandcotraders.online/e',
    beforeParse(w) {
      w.indexedDB = store.idb; w.IDBKeyRange = FDBKeyRange; w.print = () => {}; w.scrollTo = () => {}; w.open = () => null;
      for (const k of ['alert', 'confirm', 'prompt']) Object.defineProperty(w, k, { value: nativeLike(), configurable: true, writable: true });
      w.URL.createObjectURL = () => 'b'; w.URL.revokeObjectURL = () => {};
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.matchMedia = mm(false);
      w.crypto.subtle = webcrypto.subtle;
      if (!w.crypto.getRandomValues) w.crypto.getRandomValues = arr => webcrypto.getRandomValues(arr);
      w.fetch = async () => { throw new Error('offline'); };
      const ls = {};
      Object.defineProperty(w, 'localStorage', { configurable: true, value: {
        getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } } });
    }
  });
  return dom.window;
}
async function ready(w) {
  for (let i = 0; i < 400 && !(w.ERP && w.ERP.ready); i++) await sleep(25);
  await sleep(300);
  return w.ERP;
}

/* ── event helpers ── */
const mouse = (w, el, type, init = {}) => { const e = new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0 }, init)); el.dispatchEvent(e); return e; };
const key = (w, k, init = {}, el) => { const t = el || w.document.activeElement || w.document.body; const e = new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, init)); t.dispatchEvent(e); return e; };
const $ = (w, s, r) => (r || w.document).querySelector(s);
const $$ = (w, s, r) => Array.from((r || w.document).querySelectorAll(s));
const watch = (el) => { const log = []; ['input', 'change'].forEach(t => el.addEventListener(t, () => log.push(t))); return log; };
const popup = w => $(w, '.fcp');
const dlg = w => $(w, '.fcd');
const opts = w => $$(w, '.fcp-opt').map(o => o.textContent.trim());
const btn = (w, which) => $(w, '[data-fcd="' + which + '"]');
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function main() {
  /* ═══════════════ A · the stylesheet and the browser chrome ═══════════════ */
  {
    const w = kitPage(); const D = w.document;
    const css = $(w, '#fcUiKitCss');
    check('A1 the kit injects its stylesheet once', !!css && $$(w, '#fcUiKitCss').length === 1);
    check('A2 scrollbars are themed (WebKit and the Firefox fallback)', /::-webkit-scrollbar-thumb/.test(css.textContent) && /scrollbar-color/.test(css.textContent));
    check('A3 native leftovers follow dark mode (color-scheme) and use the accent colour', /html\[data-theme="dark"\]\{color-scheme:dark\}/.test(css.textContent) && /accent-color/.test(css.textContent));
    check('A4 colours come from the host\'s tokens, with fallbacks (so a host without them still works)',
      /--fc-accent:var\(--violet,#7C3AED\)/.test(css.textContent) && /--fc-surface:var\(--surface,#fff\)/.test(css.textContent));
    check('A5 checkboxes, file button, number spinners and the closed select arrow are themed',
      /input\[type=checkbox\]:checked/.test(css.textContent) && /file-selector-button/.test(css.textContent) &&
      /inner-spin-button/.test(css.textContent) && /select:not\(\[multiple\]\)/.test(css.textContent));
    check('A6 popups, dialogs and tooltips are hidden from print', /@media print\{[^}]*\.fcp[^}]*display:none/.test(css.textContent));
    check('A7 exposed as FcUI, and a second load is a no-op', !!w.FcUI && w.FcUI.version === 1 && (w.eval(KIT), $$(w, '#fcUiKitCss').length === 1));
    const meta = () => $(w, 'meta[name="theme-color"]');
    check('A8 the phone address bar colour is set for light mode', !!meta() && meta().getAttribute('content') === '#FFFFFF');
    D.documentElement.setAttribute('data-theme', 'dark'); await sleep(40);
    check('A9 …and follows dark mode', meta().getAttribute('content') === '#141220');
    D.documentElement.setAttribute('data-theme', 'light'); await sleep(40);
    check('A10 …and back to light', meta().getAttribute('content') === '#FFFFFF');
  }

  /* ═══════════════ B · the dropdown ═══════════════ */
  {
    const w = kitPage(); const D = w.document;
    const many = Array.from({ length: 30 }, (_, i) => '<option value="s' + (i + 1) + '">Shop ' + String(i + 1).padStart(2, '0') + '</option>').join('');
    D.body.innerHTML =
      '<label class="f"><span>Area</span><select id="s1"><option value="">Choose area</option><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Gamma</option></select></label>' +
      '<select id="s2" class="ur">' + many + '</select>' +
      '<select id="s3" multiple><option>x</option><option>y</option></select><select id="s4" disabled><option>x</option></select>' +
      '<select id="s5" data-fc-plain><option>x</option></select><select id="s6" size="3"><option>x</option><option>y</option></select>' +
      '<select id="s7"><optgroup label="Fruit"><option value="ap">Apple</option><option value="pe">Pear</option></optgroup><optgroup label="Veg"><option value="ca">Carrot</option></optgroup></select>' +
      '<button id="other">other</button>';
    const s1 = $(w, '#s1'), s2 = $(w, '#s2');

    const e1 = mouse(w, s1, 'mousedown');
    check('B1 pressing a dropdown stops the browser opening its own list and opens ours', e1.defaultPrevented && !!popup(w) && w.FcUI.isOpen());
    check('B2 the field keeps focus and says it is expanded', D.activeElement === s1 && s1.getAttribute('aria-expanded') === 'true');
    check('B3 every option is listed, in order', JSON.stringify(opts(w)) === JSON.stringify(['Choose area', 'Alpha', 'Beta', 'Gamma']), opts(w).join('|'));
    check('B4 the current choice is marked selected, and the placeholder row is styled as one',
      $(w, '.fcp-opt[aria-selected="true"]').textContent.trim() === 'Choose area' && $(w, '.fcp-opt.ph'));
    check('B5 a disabled option is shown but marked disabled', $$(w, '.fcp-opt')[3].getAttribute('aria-disabled') === 'true');
    check('B6 a short list has no search box', !$(w, '.fcp-q'));
    check('B7 it is a real listbox for assistive tech', $(w, '.fcp-list').getAttribute('role') === 'listbox' && $$(w, '[role=option]').length === 4);

    let log = watch(s1);
    key(w, 'ArrowDown'); key(w, 'ArrowDown');
    check('B8 arrow keys move the highlight', $(w, '.fcp-opt.on').textContent.trim() === 'Beta');
    key(w, 'ArrowDown');
    check('B9 the highlight skips a disabled option and stops at the end', $(w, '.fcp-opt.on').textContent.trim() === 'Beta');
    const ent = key(w, 'Enter');
    check('B10 Enter chooses it: value set, "input" then "change" fired once each, list closed, focus back on the field',
      s1.value === 'b' && log.join() === 'input,change' && !popup(w) && D.activeElement === s1 && ent.defaultPrevented, log.join() + ' ' + s1.value);
    check('B11 closing removes the expanded state', !s1.hasAttribute('aria-expanded'));

    mouse(w, s1, 'mousedown'); key(w, 'Escape');
    check('B12 Escape closes and changes nothing', !popup(w) && s1.value === 'b' && log.length === 2);

    mouse(w, s1, 'mousedown'); log.length = 0;
    click(w, $$(w, '.fcp-opt')[1]);
    check('B13 clicking an option chooses it', s1.value === 'a' && log.join() === 'input,change' && !popup(w));
    mouse(w, s1, 'mousedown'); log.length = 0;
    click(w, $$(w, '.fcp-opt')[1]);
    check('B14 choosing what is already chosen fires nothing (like a real select)', s1.value === 'a' && log.length === 0 && !popup(w));
    mouse(w, s1, 'mousedown'); click(w, $$(w, '.fcp-opt')[3]);
    check('B15 a disabled option cannot be chosen (the list stays open)', s1.value === 'a' && !!popup(w));
    mouse(w, D.body, 'mousedown');
    check('B16 pressing anywhere outside closes it without changing anything', !popup(w) && s1.value === 'a');
    mouse(w, s1, 'mousedown'); mouse(w, s1, 'mousedown');
    check('B17 pressing the field again closes it (a toggle)', !popup(w));

    mouse(w, s1, 'mousedown'); key(w, 'b');
    check('B18 typing a letter on a short list jumps to a match', $(w, '.fcp-opt.on').textContent.trim() === 'Beta');
    key(w, 'Enter'); check('B19 …and Enter takes it', s1.value === 'b');

    D.getElementById('other').focus(); s1.focus();
    const sp = key(w, ' ', {}, s1);
    check('B20 Space on a focused field opens the list (and the browser\'s own is stopped)', sp.defaultPrevented && !!popup(w));
    key(w, 'Escape');
    key(w, 'ArrowDown', { altKey: true }, s1);
    check('B21 Alt+Down opens it too', !!popup(w)); key(w, 'Escape');

    /* long lists */
    mouse(w, s2, 'mousedown');
    check('B22 a long list (over 8) gets a search box, and it has the keyboard focus', !!$(w, '.fcp-q') && D.activeElement === $(w, '.fcp-q'));
    check('B23 all 30 shops are there', opts(w).length === 30);
    check('B24 an Urdu-class field gives an Urdu-friendly list', popup(w).classList.contains('ur'));
    const q = $(w, '.fcp-q');
    q.value = 'shop 17'; q.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('B25 typing filters the list', JSON.stringify(opts(w)) === '["Shop 17"]', opts(w).join('|'));
    log = watch(s2); key(w, 'Enter');
    check('B26 Enter takes the top match', s2.value === 's17' && log.join() === 'input,change');
    mouse(w, s2, 'mousedown');
    check('B27 reopening highlights the current choice', $(w, '.fcp-opt.on').textContent.trim() === 'Shop 17' && $(w, '.fcp-opt[aria-selected="true"]'));
    const q2 = $(w, '.fcp-q'); q2.value = 'zzz'; q2.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('B28 no match says so instead of showing nothing', /No matches/.test($(w, '.fcp-list').textContent));
    log.length = 0; key(w, 'Enter');
    check('B29 Enter with no match closes and changes nothing', !popup(w) && log.length === 0 && s2.value === 's17');
    mouse(w, s2, 'mousedown'); key(w, 'x', {}, D.activeElement); key(w, 'Tab');
    check('B30 Tab closes and returns focus to the field, so the tab order carries on', !popup(w) && D.activeElement === s2);
    mouse(w, s2, 'mousedown'); const q3 = $(w, '.fcp-q'); q3.value = 'shop 05'; q3.dispatchEvent(new w.Event('input', { bubbles: true }));
    log.length = 0; key(w, 'Tab');
    check('B31 Tab after searching keeps what was found', s2.value === 's5' && log.join() === 'input,change');

    /* opt-outs */
    for (const [id, why] of [['s3', 'multiple'], ['s4', 'disabled'], ['s5', 'data-fc-plain'], ['s6', 'size > 1']]) {
      const ev = mouse(w, $(w, '#' + id), 'mousedown');
      check('B32 ' + why + ' selects are left to the browser', !popup(w) && !ev.defaultPrevented);
    }
    /* groups */
    mouse(w, $(w, '#s7'), 'mousedown');
    check('B33 option groups get a heading', $$(w, '.fcp-grp').map(g => g.textContent).join() === 'Fruit,Veg' && $$(w, '.fcp-opt').length === 3);
    key(w, 'Escape');

    /* the screen redrawing under an open list */
    mouse(w, s1, 'mousedown'); s1.remove(); await sleep(60);
    check('B34 if the screen is redrawn while a list is open, the list closes instead of floating', !popup(w));

    /* phone: a bottom sheet */
    D.body.insertAdjacentHTML('beforeend', '<label><span>Warehouse</span><select id="s8"><option value="1">Main</option><option value="2">Yard</option></select></label>');
    w.FcUI.sheetMode = true;
    const s8 = $(w, '#s8'); mouse(w, s8, 'mousedown');
    check('B35 on a phone the list is a bottom sheet with a dimmed backdrop', popup(w).classList.contains('sheet') && !!$(w, '.fcp-scrim'));
    check('B36 the sheet is titled from the field\'s label', $(w, '.fcp-hd b').textContent === 'Warehouse');
    click(w, $(w, '.fcp-x'));
    check('B37 its close button closes it and removes the backdrop', !popup(w) && !$(w, '.fcp-scrim'));
    mouse(w, s8, 'mousedown'); mouse(w, $(w, '.fcp-scrim'), 'mousedown');
    check('B38 tapping the backdrop closes it', !popup(w) && !$(w, '.fcp-scrim'));
    mouse(w, s2, 'mousedown');
    check('B39 on a phone the keyboard is not forced up: the search box is not auto-focused', !!$(w, '.fcp-q') && D.activeElement !== $(w, '.fcp-q'));
    key(w, 'Escape'); w.FcUI.sheetMode = undefined;
  }

  /* ═══════════════ C · the calendar ═══════════════ */
  {
    const w = kitPage(); const D = w.document;
    w.FcUI.dateHook = true;                      // jsdom cannot answer CSS.supports('selector(::-webkit-…)'); real Chrome can
    D.body.innerHTML = '<input type="date" id="d1" value="2026-09-12"><input type="date" id="d2" value="2026-09-15" min="2026-09-10" max="2026-09-25">' +
      '<input type="date" id="d3" value="2026-09-15" required><input type="date" id="d4" disabled><input type="date" id="d5" readonly><input type="month" id="m1" value="2026-09"><input type="date" id="d6">';
    const d1 = $(w, '#d1');
    const cell = iso => $(w, '[data-d="' + iso + '"]');
    w.FcUI.openDate(d1);
    check('C1 the calendar opens on the field\'s month', !!popup(w) && $(w, '.fcc-ttl').textContent === 'September 2026' && popup(w).getAttribute('data-fcp') === 'date');
    check('C2 six weeks are drawn, weeks start on Monday (1 Sep 2026 is a Tuesday, so 31 Aug leads)',
      $$(w, '.fcc-d').length === 42 && $$(w, '.fcc-d')[0].getAttribute('aria-label') === '31 August 2026' && $$(w, '.fcc-dow span')[0].textContent === 'Mo');
    check('C3 the current value is marked', $(w, '.fcc-d.sel').getAttribute('aria-label') === '12 September 2026' && $(w, '.fcc-d.sel').getAttribute('aria-pressed') === 'true');
    check('C4 keyboard focus starts on it', D.activeElement === cell('2026-09-12'));
    check('C5 days from the neighbouring months are shown muted', $(w, '.fcc-d.out') && cell('2026-08-31').classList.contains('out'));

    let log = watch(d1);
    click(w, cell('2026-09-20'));
    check('C6 clicking a day sets the value, fires input then change, closes, and returns focus',
      d1.value === '2026-09-20' && log.join() === 'input,change' && !popup(w) && D.activeElement === d1, d1.value + ' ' + log.join());

    w.FcUI.openDate(d1);
    click(w, $(w, '[data-a="next"]'));
    check('C7 next month', $(w, '.fcc-ttl').textContent === 'October 2026' && $$(w, '.fcc-d')[0].getAttribute('aria-label') === '28 September 2026');
    click(w, $(w, '[data-a="prev"]')); click(w, $(w, '[data-a="prev"]'));
    check('C8 previous month, across a shorter month', $(w, '.fcc-ttl').textContent === 'August 2026');
    click(w, $(w, '[data-a="title"]'));
    check('C9 the title switches to a month grid for the year', $$(w, '.fcc-mo').length === 12 && $(w, '.fcc-ttl').textContent === '2026');
    click(w, $(w, '[data-a="prev"]'));
    check('C10 in the month grid, prev/next move by year', $(w, '.fcc-ttl').textContent === '2025');
    click(w, $(w, '[data-a="next"]'));
    click(w, $$(w, '.fcc-mo')[2]);
    check('C11 choosing a month returns to its days', $(w, '.fcc-ttl').textContent === 'March 2026' && $$(w, '.fcc-d').length === 42);
    w.FcUI.close();
    check('C12 close() removes it', !popup(w));

    /* min / max */
    const d2 = $(w, '#d2'); w.FcUI.openDate(d2); log = watch(d2);
    check('C13 days outside min/max are disabled', cell('2026-09-09').disabled && cell('2026-09-26').disabled && !cell('2026-09-10').disabled && !cell('2026-09-25').disabled);
    click(w, cell('2026-09-26'));
    check('C14 a disabled day cannot be picked', d2.value === '2026-09-15' && !!popup(w) && log.length === 0);
    check('C15 Clear is offered when the field may be empty', !!$(w, '[data-a="clear"]'));
    click(w, $(w, '[data-a="clear"]'));
    check('C16 Clear empties the field and tells the app', d2.value === '' && log.join() === 'input,change' && !popup(w));
    w.FcUI.openDate($(w, '#d3'));
    check('C17 a required field has no Clear', !$(w, '[data-a="clear"]')); w.FcUI.close();

    /* Today */
    const d6 = $(w, '#d6'); const t = new Date();
    const todayISO = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    w.FcUI.openDate(d6);
    check('C18 an empty field opens on this month, with today marked',
      $(w, '.fcc-ttl').textContent === MONTHS[t.getMonth()] + ' ' + t.getFullYear() && $(w, '.fcc-d.today') && $(w, '.fcc-d.today').getAttribute('aria-current') === 'date' &&
      $(w, '.fcc-d.today').getAttribute('data-d') === todayISO);
    click(w, $(w, '[data-a="today"]'));
    check('C19 "Today" picks today (local date, not UTC)', d6.value === todayISO, d6.value + ' vs ' + todayISO);

    /* keyboard */
    w.FcUI.openDate(d1);                                    /* value is 2026-09-20 now */
    key(w, 'ArrowRight'); check('C20 → moves a day', D.activeElement === cell('2026-09-21'));
    key(w, 'ArrowDown'); check('C21 ↓ moves a week', D.activeElement === cell('2026-09-28'));
    key(w, 'ArrowDown'); check('C22 moving past the month follows into the next one', $(w, '.fcc-ttl').textContent === 'October 2026' && D.activeElement === cell('2026-10-05'));
    key(w, 'Home'); check('C23 Home goes to Monday of that week', D.activeElement === cell('2026-10-05'));
    key(w, 'End'); check('C24 End goes to Sunday', D.activeElement === cell('2026-10-11'));
    key(w, 'PageUp'); check('C25 PageUp goes back a month', $(w, '.fcc-ttl').textContent === 'September 2026' && D.activeElement === cell('2026-09-11'));
    key(w, 'PageDown', { shiftKey: true }); check('C26 Shift+PageDown goes forward a year', $(w, '.fcc-ttl').textContent === 'September 2027');
    log = watch(d1); key(w, 'Enter');
    check('C27 Enter picks the focused day', d1.value === '2027-09-11' && log.join() === 'input,change' && !popup(w), d1.value);
    w.FcUI.openDate(d1); const before = d1.value; key(w, 'ArrowRight'); const esc = key(w, 'Escape');
    check('C28 Escape closes without changing anything and returns focus', !popup(w) && d1.value === before && D.activeElement === d1 && esc.defaultPrevented);

    /* not for read-only / disabled */
    w.FcUI.openDate($(w, '#d4')); check('C29 a disabled date field does not open', !popup(w));
    w.FcUI.openDate($(w, '#d5')); check('C30 a read-only date field does not open', !popup(w));

    /* the calendar button — only a press on it opens ours; pressing a segment types */
    const geo = () => ({ left: 0, right: 200, top: 0, bottom: 30, width: 200, height: 30 });
    d1.getBoundingClientRect = geo;
    const inSeg = mouse(w, d1, 'click', { clientX: 40 });
    check('C31 clicking a day/month/year segment is left alone (you can still type)', !inSeg.defaultPrevented && !popup(w));
    const onIco = mouse(w, d1, 'click', { clientX: 192 });
    check('C32 clicking the calendar icon opens ours and stops the browser\'s', onIco.defaultPrevented && !!popup(w));
    key(w, 'Escape');
    w.FcUI.close();
    const alt = key(w, 'ArrowDown', { altKey: true }, d1);
    check('C33 Alt+Down on a date field opens it', alt.defaultPrevented && !!popup(w)); w.FcUI.close();

    /* month input */
    const m1 = $(w, '#m1'); w.FcUI.openDate(m1); log = watch(m1);
    check('C34 a month field shows the 12 months of a year, current one marked',
      popup(w).getAttribute('data-fcp') === 'month' && $$(w, '.fcc-mo').length === 12 && $(w, '.fcc-mo.sel').textContent === 'Sep' && $(w, '.fcc-ttl').textContent === '2026');
    click(w, $$(w, '.fcc-mo')[10]);
    check('C35 choosing a month sets YYYY-MM', m1.value === '2026-11' && log.join() === 'input,change' && !popup(w), m1.value);
    w.FcUI.openDate(m1); check('C36 its footer says "This month"', /This month/.test($(w, '.fcc-f').textContent)); w.FcUI.close();

    /* phone */
    w.FcUI.sheetMode = true; w.FcUI.openDate(d1);
    check('C37 on a phone the calendar is a bottom sheet titled Choose a date', popup(w).classList.contains('sheet') && /Choose a date/.test($(w, '.fcp-hd b').textContent));
    w.FcUI.close(); w.FcUI.sheetMode = undefined;

    /* one popup at a time */
    w.FcUI.openDate(d1); w.FcUI.openDate($(w, '#d2'));
    check('C38 only one popup is ever open', $$(w, '.fcp').length === 1);
    w.FcUI.close();
  }

  /* ═══════════════ D · dialogs ═══════════════ */
  {
    const w = kitPage(); const D = w.document;
    D.body.innerHTML = '<button id="opener">open</button><button id="second">second</button>';
    const opener = $(w, '#opener'); opener.focus();

    let p = w.FcUI.confirm('Discard this invoice?', { detail: 'Everything you entered will be lost.', okText: 'Discard', cancelText: 'Keep editing', tone: 'danger' });
    check('D1 confirm() draws a themed dialog instead of the browser\'s', !!dlg(w) && $(w, '.fcd h2').textContent === 'Discard this invoice?' && /lost/.test($(w, '.fcd p').textContent));
    check('D2 a destructive question uses the danger look and an alert role', dlg(w).classList.contains('tone-danger') && dlg(w).getAttribute('role') === 'alertdialog' && btn(w, 'ok').classList.contains('danger'));
    check('D3 the buttons say what they do', btn(w, 'ok').textContent === 'Discard' && btn(w, 'cancel').textContent === 'Keep editing');
    check('D4 a destructive question starts with the SAFE button focused', D.activeElement === btn(w, 'cancel'));
    check('D5 it is modal and named', dlg(w).getAttribute('aria-modal') === 'true' && D.getElementById(dlg(w).getAttribute('aria-labelledby')).textContent === 'Discard this invoice?');
    click(w, btn(w, 'ok'));
    check('D6 OK resolves true, removes the dialog, and returns focus to where it was', (await p) === true && !dlg(w) && D.activeElement === opener);

    p = w.FcUI.confirm('Save changes?'); check('D7 a harmless question focuses OK', D.activeElement === btn(w, 'ok') && btn(w, 'ok').classList.contains('pri'));
    key(w, 'Escape'); check('D8 Escape answers no', (await p) === false && !dlg(w));
    p = w.FcUI.confirm('Sure?', { tone: 'warn' }); click(w, btn(w, 'cancel')); check('D9 Cancel answers no', (await p) === false);
    p = w.FcUI.confirm('Sure?'); click(w, $(w, '.fcd-scrim'));
    check('D10 clicking the backdrop answers no', (await p) === false && !dlg(w));

    /* focus trap */
    p = w.FcUI.confirm('Trap?'); const ok = btn(w, 'ok'), cancel = btn(w, 'cancel');
    ok.focus(); key(w, 'Tab');
    check('D11 Tab from the last control wraps to the first (focus cannot escape behind the dialog)', D.activeElement === cancel);
    key(w, 'Tab', { shiftKey: true }); check('D12 Shift+Tab from the first wraps to the last', D.activeElement === ok);
    D.getElementById('second').focus(); key(w, 'Tab');
    check('D13 focus that got out is pulled back in', dlg(w).contains(D.activeElement));
    key(w, 'Escape'); await p;

    /* queue */
    const p1 = w.FcUI.confirm('First?'), p2 = w.FcUI.confirm('Second?');
    check('D14 two questions at once: only the first is on screen', $$(w, '.fcd').length === 1 && $(w, '.fcd h2').textContent === 'First?');
    click(w, btn(w, 'ok')); await p1;
    check('D15 …the second appears when the first is answered', $$(w, '.fcd').length === 1 && $(w, '.fcd h2').textContent === 'Second?');
    click(w, btn(w, 'cancel')); check('D16 …and is answered independently', (await p2) === false);

    /* prompt */
    p = w.FcUI.prompt('Cancel this invoice?', { detail: 'Stock is returned.', label: 'Reason', placeholder: 'Why?', okText: 'Cancel invoice', tone: 'danger' });
    const inp = $(w, '.fcd input');
    check('D17 prompt() shows a labelled text field, focused', !!inp && D.activeElement === inp && $(w, '.fcd-field label').textContent === 'Reason' && inp.placeholder === 'Why?');
    inp.value = '  wrong shop  '; key(w, 'Enter');
    check('D18 Enter submits, and the answer is trimmed', (await p) === 'wrong shop' && !dlg(w));
    p = w.FcUI.prompt('Why?'); key(w, 'Escape'); check('D19 Escape answers null (cancelled)', (await p) === null);
    p = w.FcUI.prompt('Why?'); click(w, btn(w, 'cancel')); check('D20 Cancel answers null', (await p) === null);
    p = w.FcUI.prompt('Why?'); click(w, btn(w, 'ok')); check('D21 leaving it blank is allowed by default and answers an empty string (null is reserved for "cancelled")', (await p) === '');
    p = w.FcUI.prompt('Why?', { required: true, requiredText: 'A reason is needed.' }); click(w, btn(w, 'ok'));
    check('D22 a required field refuses a blank answer, says why, and marks the field',
      !!dlg(w) && $(w, '.fcd-err').textContent === 'A reason is needed.' && $(w, '.fcd input').getAttribute('aria-invalid') === 'true');
    $(w, '.fcd input').value = 'x'; $(w, '.fcd input').dispatchEvent(new w.Event('input', { bubbles: true }));
    check('D23 typing clears the complaint', $(w, '.fcd-err').textContent === '' && !$(w, '.fcd input').hasAttribute('aria-invalid'));
    click(w, btn(w, 'ok')); check('D24 then it goes through', (await p) === 'x');
    p = w.FcUI.prompt('Why?', { value: 'draft' }); check('D25 a starting value is filled in', $(w, '.fcd input').value === 'draft'); key(w, 'Escape'); await p;
    p = w.FcUI.prompt('Why?'); $(w, '.fcd input').value = 'half typed'; click(w, $(w, '.fcd-scrim'));
    check('D26 a stray click on the backdrop does NOT throw away typed text', !!dlg(w)); key(w, 'Escape'); await p;
    p = w.FcUI.prompt('<b>x</b> "y"', { placeholder: '"q"', value: '"><img src=x>' });
    check('D27 nothing in a message or value is interpreted as HTML', !$(w, '.fcd img') && !$(w, '.fcd h2 b') && $(w, '.fcd h2').textContent === '<b>x</b> "y"' && $(w, '.fcd input').value === '"><img src=x>');
    key(w, 'Escape'); await p;

    /* alert */
    p = w.FcUI.alert('Saved.', { title: 'All done', tone: 'info' });
    check('D28 alert() has one button', !!btn(w, 'ok') && !btn(w, 'cancel') && $(w, '.fcd h2').textContent === 'All done' && $(w, '.fcd p').textContent === 'Saved.');
    click(w, btn(w, 'ok')); check('D29 OK dismisses it (resolves with nothing)', (await p) === undefined && !dlg(w));
    w.alert('Plain old alert'); check('D30 window.alert is routed to the same dialog', !!dlg(w) && $(w, '.fcd h2').textContent === 'Plain old alert');
    key(w, 'Escape'); await sleep(10);

    /* phone */
    w.FcUI.sheetMode = true; p = w.FcUI.confirm('On a phone?');
    check('D31 on a phone a dialog is a bottom sheet', $(w, '.fcd-scrim').classList.contains('sheet')); key(w, 'Escape'); await p; w.FcUI.sheetMode = undefined;

    /* a dialog closes an open popup */
    D.body.insertAdjacentHTML('beforeend', '<select id="sx"><option>a</option><option>b</option></select>');
    mouse(w, $(w, '#sx'), 'mousedown'); p = w.FcUI.confirm('x?');
    check('D32 a dialog closes any dropdown left open under it', !popup(w)); key(w, 'Escape'); await p;
  }

  /* ═══════════════ E · a host that has its OWN confirm / prompt / alert ═══════════════ */
  {
    const w = kitPage({ native: false }); let asked = [];
    w.confirm = q => { asked.push(q); return true; }; w.prompt = q => { asked.push(q); return 'because'; }; w.alert = q => { asked.push(q); };
    check('E1 a replaced confirm() is honoured — no dialog is drawn', (await w.FcUI.confirm('Go?')) === true && !$(w, '.fcd'));
    check('E2 a replaced prompt() is honoured', (await w.FcUI.prompt('Why?')) === 'because' && !$(w, '.fcd'));
    w.prompt = () => null; check('E3 …and its "cancelled" comes back as null', (await w.FcUI.prompt('Why?')) === null);
    await w.FcUI.alert('hi'); check('E4 a replaced alert() is honoured', asked.includes('hi') && !$(w, '.fcd'));
    check('E5 the question and its detail reach the replacement together', (w.confirm = q => (asked.push(q), false), (await w.FcUI.confirm('Q?', { detail: 'D.' })) === false) && asked.includes('Q?\n\nD.'));
  }

  /* ═══════════════ F · tooltips ═══════════════ */
  {
    const w = kitPage({ hover: true }); const D = w.document;
    D.body.innerHTML = '<button id="b" title="Save the invoice">Save</button><button id="i" title="Close"><svg></svg></button><button id="e" title="">x</button><span id="out">out</span>';
    const b = $(w, '#b');
    mouse(w, b, 'mouseover', { relatedTarget: D.body });
    check('F1 hovering suppresses the browser\'s own tooltip at once (the title is set aside)', !b.hasAttribute('title') && b.getAttribute('data-fc-tip') === 'Save the invoice');
    check('F2 …and ours waits a moment so it never flashes past', !$(w, '.fct'));
    await sleep(520);
    check('F3 then it appears, with the same words, as a tooltip', $(w, '.fct') && $(w, '.fct').textContent === 'Save the invoice' && $(w, '.fct').getAttribute('role') === 'tooltip' && b.getAttribute('aria-describedby') === $(w, '.fct').id);
    mouse(w, b, 'mouseout', { relatedTarget: $(w, '#out') }); await sleep(200);
    check('F4 leaving removes it and puts the title back exactly', !$(w, '.fct') && b.getAttribute('title') === 'Save the invoice' && !b.hasAttribute('data-fc-tip') && !b.hasAttribute('aria-describedby'));
    const i = $(w, '#i'); mouse(w, i, 'mouseover');
    check('F5 an icon-only button keeps its accessible name when the title is set aside', i.getAttribute('aria-label') === 'Close');
    key(w, 'Escape'); await sleep(200);
    check('F6 Escape dismisses it and restores the title', i.getAttribute('title') === 'Close' && !$(w, '.fct'));
    mouse(w, $(w, '#e'), 'mouseover'); await sleep(500);
    check('F7 an empty title makes no tooltip', !$(w, '.fct'));
    mouse(w, b, 'mouseover'); mouse(w, b, 'mousedown'); await sleep(50);
    check('F8 pressing the control dismisses the tip (it must not sit over what you are doing)', b.getAttribute('title') === 'Save the invoice');
    await sleep(600); check('F9 …and it does not appear late after being dismissed', !$(w, '.fct'));
    const w2 = kitPage({ hover: false }); w2.document.body.innerHTML = '<button id="t" title="Tip">t</button>';
    mouse(w2, $(w2, '#t'), 'mouseover');
    check('F10 on a touch device (no hover) the title is left alone', $(w2, '#t').getAttribute('title') === 'Tip');
  }

  /* ═══════════════ G · the real ERP ═══════════════ */
  {
    const store = { idb: new FDBFactory() };
    const w = appPage(store); const ERP = await ready(w); const D = w.document;
    check('G1 ERP.UI is the kit, loaded into the app', !!ERP.UI && ERP.UI === w.FcUI && !!$(w, '#fcUiKitCss'));

    /* no module may still call the browser's own dialogs */
    const mods = fs.readdirSync('.').filter(f => /^\d.*\.js$/.test(f) && f !== '36-ui-kit.js');
    const offenders = mods.filter(f => /\b(?:global|window)\.(?:confirm|prompt)\s*\(/.test(fs.readFileSync(f, 'utf8')));
    check('G2 no module calls the browser\'s confirm() / prompt() any more', offenders.length === 0, offenders.join(', '));

    await ERP.Settings.save({ allowNegativeStock: true });
    const wh = w.WAREHOUSES[0], prod = w.PRODUCTS[0], cust = w.CUSTOMERS.find(c => c.region);
    const mk = () => ERP.Invoices.save({ customerId: cust.id, warehouseId: wh.id, invoiceDate: '2026-09-05', paidAmount: 0,
      items: [{ productId: prod.id, quantity: 1, unitPrice: 20000, discount: 0, warehouseId: wh.id }] });

    /* cancel an invoice → themed prompt */
    const inv = await mk();
    ERP.actions.cancelInvoice(inv.id); await sleep(30);
    check('G3 "Cancel invoice" asks through the themed dialog, with a reason box, in the danger style',
      !!dlg(w) && $(w, '.fcd h2').textContent === 'Cancel this invoice?' && dlg(w).classList.contains('tone-danger') && D.activeElement === $(w, '.fcd input'));
    key(w, 'Escape'); await sleep(60);
    check('G4 dismissing it leaves the invoice alone', ERP.Invoices.byId(inv.id).status !== 'CANCELLED');
    ERP.actions.cancelInvoice(inv.id); await sleep(30);
    $(w, '.fcd input').value = 'wrong shop'; click(w, btn(w, 'ok')); await sleep(400);
    check('G5 confirming it cancels the invoice', ERP.Invoices.byId(inv.id).status === 'CANCELLED');

    /* edit a confirmed invoice → themed confirm */
    const inv2 = await mk();
    ERP.actions.editInvoice(inv2.id); await sleep(30);
    check('G6 editing a confirmed invoice asks first, in the warning style', !!dlg(w) && $(w, '.fcd h2').textContent === 'Edit a confirmed invoice?' && dlg(w).classList.contains('tone-warn'));
    key(w, 'Escape'); await sleep(40);
    check('G7 saying no opens nothing', !(ERP.Builder.draft && ERP.Builder.draft.existing));
    ERP.actions.editInvoice(inv2.id); await sleep(30); click(w, btn(w, 'ok')); await sleep(80);
    check('G8 saying yes opens the invoice for editing', !!(ERP.Builder.draft && ERP.Builder.draft.existing));
    ERP.Builder.draft = null;

    /* the base app's own "clear this device" button */
    const nProducts = w.PRODUCTS.length;
    D.body.insertAdjacentHTML('beforeend', '<button id="wipe" data-dbreset="1">Clear</button>');
    click(w, $(w, '#wipe')); await sleep(30);
    check('G9 the base app\'s "Clear all data" button asks through the themed dialog instead of the browser\'s',
      !!dlg(w) && /Clear all data/.test($(w, '.fcd h2').textContent) && dlg(w).classList.contains('tone-danger'));
    click(w, btn(w, 'cancel')); await sleep(60);
    check('G10 cancelling it wipes nothing and leaves window.confirm as it was', w.PRODUCTS.length === nProducts && /native code/.test(Function.prototype.toString.call(w.confirm)));

    /* the price panel: synchronous refusals stay a STRING (the panel-close trap), but there is no more
       below-cost block of any kind (§28, 2026-09-29 — client: "remove all restrictions"). A panel.save()
       that returns an object CLOSES the panel and says "Saving…" — refuse every bad input here, never later
       in a promise. */
    ERP.openPriceEditor(prod.id);
    const first = w.PANELS.prices.save({ buy: 'abc', reason: 'test' });
    check('G11 a non-number purchase price refuses synchronously, in the panel', typeof first === 'string' && /number/i.test(first), String(first));
    const second = w.PANELS.prices.save({ buy: '100', extra: '0', reason: 'test' });
    check('G12 a purchase price far below anything ever paid saves normally — no restriction of any kind',
      second && typeof second === 'object' && !!second.msg, JSON.stringify(second));
    await sleep(200);
    ERP.openPriceEditor(prod.id);
    const third = w.PANELS.prices.save({});
    check('G13 pressing Save again with nothing changed says so, inside the panel', typeof third === 'string' && /Nothing to save/i.test(third), String(third));
    await sleep(200);

    /* a real dropdown from the real app */
    w.go('invoices'); await sleep(200);
    const sel = $$(w, 'select').find(s => !s.disabled && !s.multiple && s.options.length > 1);
    check('G14 the app has ordinary dropdowns on screen', !!sel);
    if (sel) {
      const before = sel.value, other = Array.from(sel.options).find(o => o.value !== before && !o.disabled);
      const lg = watch(sel); mouse(w, sel, 'mousedown');
      check('G15 an app dropdown opens the themed list', !!popup(w) && opts(w).length === sel.options.length);
      const li = $$(w, '.fcp-opt').find(o => o.textContent.trim() === (other.label || other.text).trim());
      click(w, li);
      check('G16 choosing from it changes the real select and fires what the app listens for', sel.value === other.value && lg.join() === 'input,change');
    }
    w.close();
  }

  /* ═══════════════ H · the Warehouse app and the launcher ═══════════════ */
  {
    const vc = new VirtualConsole(); const perrs = []; vc.on('jsdomError', e => perrs.push(e.message));
    const dom = new JSDOM(PWA_HTML, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://x.local/e',
      beforeParse(w) { w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange; w.print = () => {}; w.scrollTo = () => {}; w.matchMedia = mm(false);
        w.URL.createObjectURL = () => 'b'; w.URL.revokeObjectURL = () => {}; } });
    const w = dom.window; await sleep(900);
    check('H1 the Warehouse app carries the same kit', !!w.FcUI && w.FcUI.version === 1 && !!$(w, '#fcUiKitCss'));
    check('H2 …and still boots without errors', perrs.filter(e => !/Could not load|not implemented/i.test(e)).length === 0, perrs.slice(0, 2).join(' | '));
    w.document.body.insertAdjacentHTML('beforeend', '<div class="sel"><select id="ws"><option value="1">Main</option><option value="2">Yard</option></select></div>');
    const ws = $(w, '#ws'), lg = watch(ws); mouse(w, ws, 'mousedown');
    check('H3 its dropdowns open the themed list too', !!popup(w));
    click(w, $$(w, '.fcp-opt')[1]);
    check('H4 and choosing works', ws.value === '2' && lg.join() === 'input,change');
    check('H5 the Warehouse app\'s own arrow is not doubled (its .sel wrapper keeps its chevron)', /\.sel>select\{background-image:none !important\}/.test($(w, '#fcUiKitCss').textContent));
    w.close();

    const blob = (key) => Buffer.from(new RegExp(key + ":\\{title:'[^']*',b64:'([^']*)'").exec(LAUNCHER)[1], 'base64').toString('utf8');
    const lf = s => s.replace(/\r\n/g, '\n');          // build.py writes dist/ with CRLF on Windows; the blob is encoded from LF text
    check('H6 the launcher\'s embedded Office copy is this build, kit included', /FcUI/.test(blob('erp')) && lf(blob('erp')) === lf(ERP_HTML));
    check('H7 the launcher\'s embedded Warehouse copy is this build, kit included', /FcUI/.test(blob('pwa')) && lf(blob('pwa')) === lf(PWA_HTML));
  }

  finished = true;
  console.log(out.join('\n'));
  const real = errors.filter(e => !/Could not load|not implemented|offline|navigation/i.test(e));
  if (real.length) console.log('\njsdom errors:', real.slice(0, 5));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
