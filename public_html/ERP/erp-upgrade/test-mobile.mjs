/* Drives the ERP as a phone would: 390 × 844, the mobile media query on,
   touch-sized controls, bottom navigation. jsdom does no layout, so this
   checks the structure and behaviour the CSS depends on, not pixels. */
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

const HTML = fs.readFileSync('dist/farooq-co-erp.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
const check = (n, c, d) => { if (c) { pass++; out.push('  ✔ ' + n); } else { fail++; out.push('  ✘ ' + n + (d ? '   → ' + d : '')); } };

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));

/* a phone-sized window with a working matchMedia */
let width = 390;
const listeners = [];
function makeMedia(w) {
  return q => {
    const m = /max-width:\s*(\d+)/.exec(q);
    const matches = m ? w <= +m[1] : false;
    const obj = {
      media: q, matches,
      addEventListener: (_, fn) => listeners.push(fn),
      removeEventListener: () => {},
      addListener: fn => listeners.push(fn),
      removeListener: () => {}
    };
    return obj;
  };
}

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  url: 'https://farooq.local/erp',
  beforeParse(w) {
    w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
    w.print = () => {}; w.confirm = () => true; w.prompt = () => 'r'; w.scrollTo = () => {};
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.open = () => null;
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.matchMedia = makeMedia(390);
    Object.defineProperty(w, 'innerWidth', { get: () => width, configurable: true });
    Object.defineProperty(w, 'innerHeight', { get: () => 844, configurable: true });
  }
});
const win = dom.window, D = win.document;
const $ = s => D.querySelector(s);
const $$ = s => Array.from(D.querySelectorAll(s));
const click = el => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const type = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); } };
const change = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); } };

const run = async () => {
  for (let i = 0; i < 600 && !(win.ERP && win.ERP.fullyReady); i++) await sleep(25);
  const ERP = win.ERP;
  check('M0 the app knows it is on a phone', ERP.isMobile() === true && D.body.classList.contains('fc-mobile'));
  check('M1 the viewport allows for the notch', /viewport-fit=cover/.test($('meta[name=viewport]').content));

  /* ── bottom navigation ── */
  const bar = $('#fcTabbar');
  check('M2 a bottom navigation bar is present', !!bar && bar.children.length === 5);
  check('M3 it offers Home, Sales, New, Stock and More',
        Array.from(bar.children).map(b => b.textContent.trim()).join('|') === 'Home|Sales|New|Stock|More',
        bar ? Array.from(bar.children).map(b => b.textContent.trim()).join('|') : '');
  click(bar.querySelector('[data-fctab="inventory"]')); await sleep(80);
  check('M4 tapping Stock navigates', win.cur === 'inventory');
  check('M5 the current tab is marked',
        bar.querySelector('[data-fctab="inventory"]').classList.contains('on'));
  click($('#fcTabbar [data-fctab="more"]')); await sleep(60);
  check('M6 More opens the navigation drawer', D.body.classList.contains('drawer'));
  click($('#fcTabbar [data-fctab="more"]')); await sleep(60);

  /* ── New goes straight into an invoice ── */
  click($('#fcTabbar [data-fctab="newsale"]')); await sleep(120);
  check('M7 New opens the invoice editor', win.cur === 'invoiceBuilder' && !!$('#fcbuilder'));
  check('M8 the body is marked so the page leaves room for both bars',
        D.body.classList.contains('fc-builder'));

  /* ── stock, then a real multi-line invoice on the phone ── */
  const wh = win.WAREHOUSES[1].id;
  const prods = win.PRODUCTS.filter(p => p.active !== false).slice(0, 4);
  if (win.ERP.Prices) prods.forEach(p => win.ERP.Prices.set(p.id, 2000, 3000));
  await ERP.Purchases.save({
    supplierId: win.SUPPLIERS[0].id, warehouseId: wh,
    items: prods.map(p => ({ productId: p.id, quantity: 300, unitPrice: 2000 }))
  });
  click($('#fcTabbar [data-fctab="newsale"]')); await sleep(120);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(80);
  change($('[data-fcb="customerId"]'), win.CUSTOMERS[3].id); await sleep(80);

  click($('[data-fcbact="openpicker"]')); await sleep(80);
  check('M9 the product list opens as a sheet', !!$('.fcb-results') && D.body.classList.contains('fc-sheet'));
  check('M10 a dimmed backdrop is available to close it', !!$('#fcSheetScrim'));
  type($('#fcbPick'), prods[0].en || prods[0].ur); await sleep(80);
  click($$('.fcb-res').find(b => b.dataset.fcbadd === prods[0].id) || $('.fcb-res')); await sleep(80);
  check('M11 tapping a product adds a line', $$('[data-fcline="qty"]').length === 1);
  for (let i = 1; i < 3; i++) {
    type($('#fcbPick'), prods[i].en || prods[i].ur); await sleep(60);
    click($$('.fcb-res').find(b => b.dataset.fcbadd === prods[i].id) || $('.fcb-res')); await sleep(60);
  }
  check('M12 three products added without leaving the sheet',
        $$('[data-fcline="qty"]').length === 3 && D.body.classList.contains('fc-sheet'));
  click($('#fcSheetScrim')); await sleep(80);
  check('M13 tapping the backdrop closes the sheet',
        !$('.fcb-results') && !D.body.classList.contains('fc-sheet'));

  /* ── the rows carry their labels so they read as cards ── */
  const row = $('#fcbLines tr');
  const labels = Array.from(row.children).map(td => td.getAttribute('data-label'));
  check('M14 every cell is labelled for the stacked layout',
        labels.includes('Product') && labels.includes('Quantity') && labels.includes('Rate') &&
        labels.includes('Amount'), labels.join(','));
  check('M15 quantity fields ask for the number keypad',
        $('[data-fcline="qty"]').getAttribute('inputmode') === 'decimal');

  $$('[data-fcline="qty"]').forEach((el, i) => type(el, String(10 + i)));
  // Removed rate typing: rate is read-only for Sales and prefilled from sellingPrice
  await sleep(80);
  check('M16 the running total is in the action bar',
        $('.fcb-stotals').textContent.includes('Grand total'));
  check('M17 the save button is in reach at the bottom',
        !!$('.fcb-sticky [data-fcbact="save"]'));

  const before = ERP.Invoices.all().length;
  click($('[data-fcbact="save"]')); await sleep(700);
  check('M18 the invoice saves from the phone', ERP.Invoices.all().length === before + 1,
        $('.fcb-errs') ? $('.fcb-errs').textContent.replace(/\s+/g, ' ').slice(0, 120) : '');
  await sleep(400);
  check('M19 the preview opens fitted to the screen, not at full A4',
        !!$('#fcviewer.on') && ERP.Viewer.zoom < 0.6 && ERP.Viewer.zoom > 0.3,
        String(ERP.Viewer.zoom));
  check('M20 the navigation bar hides behind the preview',
        D.body.classList.contains('fc-hidechrome'));
  check('M21 print, PDF, Word and WhatsApp are all reachable',
        !!$('[data-fcv="print"]') && !!$('[data-fcv="pdf"]') &&
        !!$('[data-fcv="word"]') && !!$('[data-fcv="wa"]'));
  click($('[data-fcv="close"]')); await sleep(100);
  check('M22 closing the preview brings the navigation back',
        !D.body.classList.contains('fc-hidechrome') && !!$('#fcTabbar'));

  /* ── the invoice list reads as cards ── */
  win.go('invoices'); await sleep(120);
  const cell = $('table.fcb-list td');
  check('M23 list rows are labelled so they stack into cards',
        !!cell && !!cell.getAttribute('data-label'), cell ? cell.outerHTML.slice(0, 60) : 'no rows');
  check('M24 row actions are present for a thumb',
        $$('.fcb-rowacts .btn').length >= 4);
  check('M25 search is available on the phone', !!$('[data-fcq]'));

  /* ── the app's own tables stack as well ── */
  win.go('inventory'); await sleep(200);
  const stockTable = $('#view .tw > table');
  const labelled = stockTable && Array.from(stockTable.querySelectorAll('tbody td'))
    .some(td => (td.getAttribute('data-label') || '').length > 0);
  check('M25b the original screens\' tables are labelled for stacking too', !!labelled,
        stockTable ? 'table found, labels missing' : 'no table on this page');
  check('M25c the labels are the real column headings',
        Array.from(stockTable.querySelectorAll('tbody tr:first-child td'))
          .map(td => td.getAttribute('data-label')).filter(Boolean).length >= 3);
  win.go('dashboard'); await sleep(200);
  const dash = $('#view .tw > table');
  check('M25d labelling happens on every screen, not just the first',
        !dash || Array.from(dash.querySelectorAll('tbody td')).some(td => td.getAttribute('data-label')));

  /* ── the reports room on a phone ── */
  win.go('reports'); await sleep(250);
  check('M25e the reports screen offers periods and report types on a phone',
        $$('[data-rpkind]').length>0 && $$('[data-rptab]').length>0,
        `${$$('[data-rpkind]').length} periods / ${$$('[data-rptab]').length} tabs`);
  check('M25f its figures and table render at phone width',
        $('#view').textContent.length>400 && !!$('#view table'));
  check('M25g the export buttons are reachable', $$('[data-rpexport]').length>=3,
        String($$('[data-rpexport]').length));

  /* ── the account statement on a phone ── */
  win.go('khata', win.CUSTOMERS[3].id); await sleep(250);
  check('M25h the account statement opens on a phone with its summary cards',
        !!$('.kh-cards') && $('.kh-cards').children.length >= 4);
  check('M25i its ledger stacks into labelled cards',
        (() => { const td = $('table.kh-table tbody td');
          return !td || !!td.getAttribute('data-label'); })());
  check('M25j payment, adjustment and export stay reachable',
        !!$('[data-khpay]') && !!$('[data-khadjust]') && $$('[data-khexport]').length >= 3);

  /* ── rotating the phone ── */
  width = 844;
  win.matchMedia = makeMedia(844);
  listeners.forEach(fn => { try { fn({ matches: false }); } catch (e) {} });
  win.dispatchEvent(new win.Event('resize')); await sleep(300);
  check('M26 turning to a wide screen drops the phone layout',
        !D.body.classList.contains('fc-mobile'));
  width = 390;
  win.matchMedia = makeMedia(390);
  listeners.forEach(fn => { try { fn({ matches: true }); } catch (e) {} });
  win.dispatchEvent(new win.Event('resize')); await sleep(300);
  check('M27 turning back restores it', D.body.classList.contains('fc-mobile'));

  /* ── every screen still renders at phone width ── */
  for (const p of ['dashboard', 'inventory', 'purchases', 'invoices', 'orders', 'dispatch',
                   'customers', 'suppliers', 'payments', 'reports', 'documents', 'alerts', 'settings']) {
    let ok = true, err = '';
    try { win.go(p); await sleep(40); ok = $('#view').innerHTML.length > 100 && !!$('#fcTabbar'); }
    catch (e) { ok = false; err = e.message; }
    check('M28:' + p + ' works at phone width', ok, err);
  }

  /* ── the other entry screens on a phone ── */
  for (const mode of ['purchase', 'transfer', 'receive', 'adjust', 'dispatch', 'order']) {
    win.ERP.Builder.start(mode); await sleep(70);
    click($('[data-fcbact="openpicker"]')); await sleep(50);
    const listed = $$('.fcb-res').length > 0;
    click($('.fcb-res')); await sleep(60);
    check('M29:' + mode + ' takes a line on a phone',
          listed && $$('[data-fcline="qty"]').length === 1 && !!$('.fcb-sticky [data-fcbact="save"]'));
  }

  check('M30 nothing threw during the whole phone session', errors.length === 0,
        errors.slice(0, 2).join(' | '));

  console.log('\n' + out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
};
run().catch(e => { console.error('HARNESS ERROR:', e); console.log(out.join('\n')); process.exit(2); });
