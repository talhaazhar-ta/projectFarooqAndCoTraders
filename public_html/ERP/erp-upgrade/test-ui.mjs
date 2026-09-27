/* Drives the built ERP through its own DOM — real clicks, real typing — so
   the Add Item flow and every builder mode are exercised the way a person
   uses them, not through the service layer. */
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';

const HTML = fs.readFileSync('dist/farooq-co-erp.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push('  ✔ ' + name); }
  else { fail++; out.push('  ✘ ' + name + (detail ? '   → ' + detail : '')); }
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));
vc.on('error', (...a) => errors.push(String(a[0])));

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  url: 'https://farooq.local/erp',
  beforeParse(w) {
    w.indexedDB = new FDBFactory(); w.IDBKeyRange = FDBKeyRange;
    w.print = () => {}; w.confirm = () => true; w.prompt = () => 'reason'; w.alert = () => {};
    w.scrollTo = () => {}; w.open = () => null;
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.HTMLElement.prototype.scrollIntoView = function () {};
  }
});
const win = dom.window, D = win.document;

function click(el) {
  if (!el) return false;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}
function type(el, value) {
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  return true;
}
function change(el, value) {
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return true;
}
const $ = s => D.querySelector(s);
const $$ = s => Array.from(D.querySelectorAll(s));

const run = async () => {
  for (let i = 0; i < 600 && !(win.ERP && win.ERP.fullyReady); i++) await sleep(25);
  const ERP = win.ERP, M = win.Money;
  check('UI0 app boots with no console errors', !!ERP && errors.length === 0, errors.slice(0, 2).join(' | '));

  /* stock to sell */
  const wh = win.WAREHOUSES[1].id;
  const prods = win.PRODUCTS.filter(p => p.active !== false).slice(0, 8);
  if (win.ERP.Prices) {
    for (let i = 0; i < prods.length; i++) {
      await win.ERP.Prices.set(prods[i].id, { buy: '2000', sell: String(3000 + i * 100) }, { reason: 'test' }).catch(()=>{ prods[i].sell = 3000 + i * 100; });
    }
  }
  await ERP.Purchases.save({
    supplierId: win.SUPPLIERS[0].id, warehouseId: wh,
    items: prods.map(p => ({ productId: p.id, quantity: 500, unitPrice: 2000 }))
  });

  /* ── the New Invoice button on the invoice list ── */
  win.go('invoices'); await sleep(60);
  check('UI1 invoice list renders', !!$('[data-fcnew="sale"]'));
  click($('[data-fcnew="sale"]')); await sleep(80);
  check('UI2 New Invoice opens the builder', win.cur === 'invoiceBuilder' && !!$('#fcbuilder'));
  check('UI3 the builder shows an Add Item control', !!$('[data-fcbact="openpicker"]') && !!$('#fcbPick'));
  change($('[data-fcb="warehouseId"]'), wh); await sleep(80);
  check('UI3b choosing the warehouse keeps the builder open',
        win.cur === 'invoiceBuilder' && win.ERP.Builder.draft.warehouseId === wh);

  /* ── Add Item: press the button, then search, then pick ── */
  click($('[data-fcbact="openpicker"]')); await sleep(60);
  check('UI4 Add Item opens the product list', !!$('.fcb-results'), 'no results panel');
  check('UI5 the list is populated before typing', $$('.fcb-res').length > 0,
        String($$('.fcb-res').length));

  const target = prods[0];
  type($('#fcbPick'), (target.en || target.ur).slice(0, 5)); await sleep(80);
  check('UI6 typing filters the list', $$('.fcb-res').length > 0, String($$('.fcb-res').length));
  check('UI7 each result shows warehouse stock',
        /Available:\s*[\d,]+\s*Bags/.test($('.fcb-res') ? $('.fcb-res').textContent : ''),
        $('.fcb-res') && $('.fcb-res').textContent.replace(/\s+/g, ' ').slice(0, 80));

  click($('.fcb-res')); await sleep(80);
  check('UI8 clicking a result adds a line', $$('[data-fcline="qty"]').length === 1,
        String($$('[data-fcline="qty"]').length));
  check('UI9 the list stays open and clears, ready for the next product',
        !!$('.fcb-results') && $('#fcbPick').value === '');

  /* the controls a person is using must survive adding a line */
  const shopSelect = $('[data-fcb="customerId"]');
  const whSelect = $('[data-fcb="warehouseId"]');
  click($('[data-fcbact="openpicker"]')); await sleep(40);
  type($('#fcbPick'), prods[1].en || prods[1].ur); await sleep(60);
  click($$('.fcb-res').find(b => b.dataset.fcbadd === prods[1].id) || $('.fcb-res')); await sleep(60);
  check('UI9b adding a line does not rebuild the dropdowns',
        $('[data-fcb="customerId"]') === shopSelect && $('[data-fcb="warehouseId"]') === whSelect);
  check('UI9c the extra line was still added', $$('[data-fcline="qty"]').length === 2);
  click($$('[data-fcdel]')[1]); await sleep(60);
  check('UI9d removing a line does not rebuild the dropdowns',
        $('[data-fcb="customerId"]') === shopSelect && $$('[data-fcline="qty"]').length === 1);

  /* the plain product list works as well as the search */
  const plain = $('#fcbPlain');
  check('UI9e a plain product list is offered as well', !!plain && plain.options.length > 100,
        plain ? String(plain.options.length) : 'missing');
  change(plain, prods[2].id); await sleep(30);
  click($('[data-fcbact="addplain"]')); await sleep(80);
  check('UI9f the plain list adds a line too',
        $$('[data-fcline="qty"]').length === 2 &&
        win.ERP.Builder.draft.items.some(i => i.productId === prods[2].id));
  click($$('[data-fcdel]')[1]); await sleep(60);

  /* ── add four more lines ── */
  for (let i = 1; i < 5; i++) {
    click($('[data-fcbact="openpicker"]')); await sleep(40);
    type($('#fcbPick'), prods[i].en || prods[i].ur); await sleep(50);
    const hit = $$('.fcb-res').find(b => b.dataset.fcbadd === prods[i].id) || $('.fcb-res');
    click(hit); await sleep(60);
  }
  check('UI10 five lines in the editor', $$('[data-fcline="qty"]').length === 5,
        String($$('[data-fcline="qty"]').length));
  check('UI11 five distinct products',
        new Set(win.ERP.Builder.draft.items.map(i => i.productId)).size === 5);

  /* ── type quantities ── */
  $$('[data-fcline="qty"]').forEach((el, i) => type(el, String(10 + i)));
  // Removed rate typing: rate is read-only for Sales and prefilled from sellingPrice
  await sleep(60);
  const expected = [0, 1, 2, 3, 4].reduce((a, i) => a + (10 + i) * (3000 + i * 100), 0);
  const firstQty = $$('[data-fcline="qty"]')[0];
  type(firstQty, '10'); await sleep(40);
  check('UI11b typing a quantity does not replace the input you are in',
        $$('[data-fcline="qty"]')[0] === firstQty);
  check('UI12 line amounts update as you type',
        $('[data-fcamt="0"]').textContent.replace(/,/g, '') === '30000.00',
        $('[data-fcamt="0"]').textContent);
  check('UI13 the summary totals the whole load',
        $('#fcbSum').textContent.includes(expected.toLocaleString('en-US')),
        $('#fcbSum').textContent.replace(/\s+/g, ' ').slice(0, 120));
  check('UI14 the sticky bar mirrors the summary',
        $('.fcb-stotals').textContent.includes(expected.toLocaleString('en-US')));

  /* ── remove a line, reorder, change a quantity ── */
  const beforeRemove = win.ERP.Builder.draft.items.map(i => i.productId);
  click($$('[data-fcdel]')[1]); await sleep(60);
  check('UI15 remove drops exactly that line',
        $$('[data-fcline="qty"]').length === 4 &&
        !win.ERP.Builder.draft.items.some(i => i.productId === beforeRemove[1]));
  const order = win.ERP.Builder.draft.items.map(i => i.productId);
  click($$('[data-fcmove="down"]')[0]); await sleep(60);
  check('UI16 reorder moves the line down',
        win.ERP.Builder.draft.items[0].productId === order[1] &&
        win.ERP.Builder.draft.items[1].productId === order[0]);

  /* ── choose the shop, warehouse and a payment ── */
  change($('[data-fcb="customerId"]'), win.CUSTOMERS[5].id); await sleep(80);
  check('UI17 choosing a shop shows its balance and owner',
        !!$('.fcb-party') && $('.fcb-party').textContent.includes('Current balance'));
  check('UI18 the lines survive choosing a shop', $$('[data-fcline="qty"]').length === 4,
        String($$('[data-fcline="qty"]').length));
  type($('[data-fcb="paidAmount"]'), '50000'); await sleep(50);
  check('UI19 paid amount feeds the remaining balance',
        $('.fcb-check').textContent.includes('balance after this payment'));

  /* ── overselling is blocked in the UI before saving ── */
  type($$('[data-fcline="qty"]')[0], '999999'); await sleep(50);
  check('UI20 an over-sold line is flagged on screen',
        !!$('tr.over') && $('.fcb-avail.bad') !== null);
  click($('[data-fcbact="save"]')); await sleep(200);
  check('UI21 saving an over-sold load is refused with an explanation',
        !!$('.fcb-errs') && /Only .* bags of .* available/i.test($('.fcb-errs').textContent),
        $('.fcb-errs') ? $('.fcb-errs').textContent.replace(/\s+/g, ' ').slice(0, 120) : 'no error box');
  type($$('[data-fcline="qty"]')[0], '12'); await sleep(50);

  /* ── save for real ── */
  const invBefore = ERP.Invoices.all().length;
  click($('[data-fcbact="save"]')); await sleep(500);
  check('UI22 the invoice saves', ERP.Invoices.all().length === invBefore + 1);
  const saved = ERP.Invoices.all()[0];
  check('UI23 all four lines are stored under one invoice',
        ERP.Invoices.items(saved.id).length === 4 && !!saved.invoiceNumber);
  check('UI24 the app navigates back to the invoice list', win.cur === 'invoices');
  await sleep(400);
  check('UI25 the invoice preview opens after saving', !!$('#fcviewer.on'),
        $('#fcviewer') ? $('#fcviewer').className : 'no viewer');
  check('UI26 the preview is the classic sheet with every line',
        $('#fcviewer').textContent.includes('Bill to Party') &&
        ERP.Invoices.items(saved.id).every(it =>
          $('#fcviewer').textContent.includes(win.Money.fmtPlain(it.lineTotal))));

  /* ── viewer toolbar ── */
  check('UI27 the toolbar offers print, PDF and Word',
        !!$('[data-fcv="print"]') && !!$('[data-fcv="pdf"]') && !!$('[data-fcv="word"]'));
  let downloaded = null;
  win.document.createElement = (function (orig) {
    return function (tag) {
      const el = orig.call(win.document, tag);
      if (tag === 'a') { const c = el.click.bind(el); el.click = () => { downloaded = el.download; }; }
      return el;
    };
  })(win.document.createElement);
  click($('[data-fcv="word"]')); await sleep(200);
  check('UI27b exporting offers the editor first', !!$('#fcExport.on') && !!$('[data-fcx="edit"]'));
  click($('[data-fcx="now"]')); await sleep(300);
  check('UI28 Download Word produces a .docx file', !!downloaded && /\.docx$/.test(downloaded), String(downloaded));
  click($('[data-fcv="close"]')); await sleep(80);
  check('UI29 the viewer closes', !$('#fcviewer.on'));

  /* ── the list row actions ── */
  win.go('invoices'); await sleep(80);
  check('UI30 the saved invoice appears in the list',
        D.body.textContent.includes(saved.invoiceNumber));
  click($('[data-fcinv="view"]')); await sleep(200);
  check('UI31 View opens the invoice', !!$('#fcviewer.on'));
  click($('[data-fcv="close"]')); await sleep(60);
  click($('[data-fcinv="dup"]')); await sleep(150);
  check('UI32 Duplicate opens a new draft with the same lines',
        win.cur === 'invoiceBuilder' && win.ERP.Builder.draft.items.length === 4 &&
        !win.ERP.Builder.draft.invoiceNumber);
  click($('[data-fcbact="cancel"]')); await sleep(100);

  /* ── search and filters ── */
  win.go('invoices'); await sleep(60);
  const listText = () => ($('#view') ? $('#view').textContent : '');
  type($('[data-fcq]'), saved.shopNameSnapshot.slice(0, 6)); await sleep(400);
  check('UI33 search finds the invoice by shop name', listText().includes(saved.invoiceNumber));
  type($('[data-fcq]'), 'zzz-no-such-thing'); await sleep(400);
  check('UI34 a search with no hits shows the empty state',
        !listText().includes(saved.invoiceNumber) && $$('table.fcb-list tbody tr').length === 0);
  check('UI34b the closed preview leaves nothing behind',
        !$('#fcviewer') || $('#fcviewer').innerHTML === '');
  type($('[data-fcq]'), ''); await sleep(400);

  /* ── every other builder mode opens and takes a line ── */
  for (const mode of ['purchase', 'order', 'quotation', 'dispatch', 'transfer', 'receive', 'adjust', 'supreturn']) {
    win.ERP.Builder.start(mode); await sleep(80);
    const opened = win.cur === 'invoiceBuilder' && !!$('#fcbuilder');
    click($('[data-fcbact="openpicker"]')); await sleep(50);
    const listed = $$('.fcb-res').length > 0;
    click($('.fcb-res')); await sleep(70);
    const added = $$('[data-fcline="qty"]').length === 1;
    type($('[data-fcline="qty"]'), '5'); await sleep(30);
    check('UI35:' + mode + ' opens, lists products and takes a line',
          opened && listed && added, `opened=${opened} listed=${listed} added=${added}`);
  }

  /* transfer end to end through the UI */
  win.ERP.Builder.start('transfer'); await sleep(60);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(60);
  for (let i = 0; i < 3; i++) {
    click($('[data-fcbact="openpicker"]')); await sleep(40);
    type($('#fcbPick'), prods[i].en || prods[i].ur); await sleep(50);
    const hit = $$('.fcb-res').find(b => b.dataset.fcbadd === prods[i].id) || $('.fcb-res');
    click(hit); await sleep(50);
  }
  $$('[data-fcline="qty"]').forEach(el => type(el, '10'));
  change($('[data-fcb="toWarehouseId"]'), win.WAREHOUSES[0].id); await sleep(60);
  const trfBefore = ERP.StockDocs.byType('TRANSFER').length;
  click($('[data-fcbact="save"]')); await sleep(500);
  check('UI36 a three-product transfer saves from the screen',
        ERP.StockDocs.byType('TRANSFER').length === trfBefore + 1,
        $('.fcb-errs') ? $('.fcb-errs').textContent.replace(/\s+/g, ' ').slice(0, 140) : '');

  await sleep(500);
  check('UI36b the transfer note opens after saving', !!$('#fcviewer.on') &&
        $('#fcviewer').textContent.includes('WAREHOUSE TRANSFER NOTE'),
        $('#fcviewer') ? $('#fcviewer').textContent.slice(0, 60) : 'no viewer');
  click($('[data-fcv="close"]')); await sleep(60);

  /* ── the new document lists ── */
  win.go('inventory'); await sleep(80);
  check('UI36c inventory offers Add Stock, Transfer and Adjust',
        !!$('[data-fcnew="receive"]') && !!$('[data-fcnew="transfer"]') && !!$('[data-fcnew="adjust"]'));
  check('UI36d the transfer appears in its own list with a document button',
        !!$('[data-fcdoc="stock"]'));
  click($('[data-fcdoc="stock"]')); await sleep(300);
  check('UI36e opening a stock document shows every line',
        !!$('#fcviewer.on') && /TRANSFER|RECEIPT|ADJUSTMENT/.test($('#fcviewer').textContent),
        $('#fcviewer') ? $('#fcviewer').textContent.replace(/\s+/g, ' ').slice(0, 70) : 'no viewer');
  click($('[data-fcv="close"]')); await sleep(60);

  /* ── an order, then turning it into an invoice ── */
  win.ERP.Builder.start('order'); await sleep(60);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(50);
  change($('[data-fcb="customerId"]'), win.CUSTOMERS[7].id); await sleep(60);
  for (let i = 0; i < 2; i++) {
    click($('[data-fcbact="openpicker"]')); await sleep(40);
    type($('#fcbPick'), prods[i].en || prods[i].ur); await sleep(50);
    const hit = $$('.fcb-res').find(b => b.dataset.fcbadd === prods[i].id) || $('.fcb-res');
    click(hit); await sleep(50);
  }
  $$('[data-fcline="qty"]').forEach(el => type(el, '8'));
  $$('[data-fcline="rate"]').forEach(el => type(el, '3200'));
  await sleep(50);
  click($('[data-fcbact="save"]')); await sleep(900);
  check('UI36f a two-line order saves and opens its document',
        ERP.Orders.all().length === 1 && !!$('#fcviewer.on') &&
        $('#fcviewer').textContent.includes('SALES ORDER'),
        $('.fcb-errs') ? $('.fcb-errs').textContent.replace(/\s+/g, ' ').slice(0, 120) : '');
  check('UI36g the order document offers Raise Invoice', !!$('[data-fcv="toinvoice"]'));
  click($('[data-fcv="toinvoice"]')); await sleep(200);
  check('UI36h Raise Invoice carries both lines into a new invoice',
        win.cur === 'invoiceBuilder' && win.ERP.Builder.draft.items.length === 2);
  click($('[data-fcbact="cancel"]')); await sleep(80);
  win.go('orders'); await sleep(60);
  check('UI36i the orders page lists the order', !!$('[data-fcdoc="order"]'));

  /* ── payment panel with allocation ── */
  win.openPanel('payment'); await sleep(120);
  check('UI37 the payment panel opens with a shop selector', !!$('#fcPayCust'));
  change($('#fcPayCust'), saved.customerId); await sleep(60);
  change($('#fcPayMode'), 'pick'); await sleep(80);
  check('UI38 choosing "pick invoices" lists the unpaid invoices', $$('[data-fcalloc]').length > 0,
        String($$('[data-fcalloc]').length));
  const closeBtn = $('#panel .x') || $('[data-close]') || $('#scrim');
  if (closeBtn) click(closeBtn);
  await sleep(80);

  /* ── customer return panel ── */
  win.ERP.setPayFor && win.ERP.setPayFor(null);
  win.go('invoices'); await sleep(60);
  click($('[data-fcinv="return"]')); await sleep(150);
  check('UI39 the return panel lists every line of the invoice with a condition',
        $$('[data-fcret]').length === 4 && $$('[data-fcretcond]').length === 4,
        `${$$('[data-fcret]').length}/${$$('[data-fcretcond]').length}`);
  /* 2026-09-26: three plain choices — "Hold as customer credit" was identical to "take it off" in the books */
  check('UI40 the return panel offers the financial treatments',
        !!$('[data-f="treatment"]') && $('[data-f="treatment"]').options.length === 3 &&
        Array.from($('[data-f="treatment"]').options).map(o => o.value).join() === 'ADJUST_OUTSTANDING_BALANCE,REFUND,REPLACEMENT');

  win.openPanel('smsconnect'); await sleep(120);
  check('UI40b the SMS provider panel opens', !!$('[data-f="smsProvider"]'));
  const cb = $('#panel .x') || $('[data-close]') || $('#scrim');
  if (cb) click(cb); await sleep(60);

  /* ── settings ── */
  win.go('settings'); await sleep(120);
  check('UI41 settings shows the business profile fields',
        !!$('[data-fcset="businessName"]') && !!$('[data-fcset="invoiceTemplate"]'));
  check('UI41b settings is a panel with its own sections and search',
        $$('[data-stsection]').length >= 8 && !!$('[data-stq]'));
  click($('[data-stsection="data"]')); await sleep(200);
  check('UI42 the data section shows the database status and backup',
        $('#view').textContent.includes('Database') && !!$('[data-fcbact="backup"]'));
  click($('[data-stsection="general"]')); await sleep(150);

  /* ── the database chip in the shell ── */
  check('UI43 the shell shows the database status', !!$('#fcDbChip'),
        $('#fcDbChip') ? $('#fcDbChip').textContent : 'missing');

  /* ── every page still renders after all that ── */
  for (const p of ['dashboard', 'inventory', 'purchases', 'sales', 'invoices', 'orders', 'dispatch',
                   'customers', 'suppliers', 'payments', 'reports', 'documents', 'alerts', 'users', 'settings']) {
    let ok = true, err = '';
    try { win.go(p); await sleep(30); ok = D.querySelector('#view').innerHTML.length > 100; }
    catch (e) { ok = false; err = e.message; }
    check('UI44:' + p + ' renders through the shell', ok, err);
  }
  check('UI45 no uncaught errors during the whole session', errors.length === 0,
        errors.slice(0, 3).join(' | '));

  console.log('\n' + out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
};
run().catch(e => { console.error('HARNESS ERROR:', e); console.log(out.join('\n')); process.exit(2); });
