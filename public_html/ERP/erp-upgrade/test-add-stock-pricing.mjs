/* Add stock (Inventory → Add stock, Builder mode "receive") and Purchases → Receive stock were simplified
   further 2026-09-29 (§28, client): "no need to ask for extra costs for any product added — just purchase
   price… remove extra prices of the products in charges & prices section… same in inventory addStock". This
   file covers:
     - there is no per-product pricing box of any kind on either screen any more — just the purchase price
       typed on the line itself;
     - Save keeps the purchase price on the line UNCHANGED and blends it into the stock's own average — the
       product's extra cost / chosen purchase price (set on the Prices screen) are never touched by a receipt;
     - the sale screen's rate cell is EDITABLE (no restriction — client: "remove all restrictions"), with an
       Edit button that opens the product Prices panel (data-fcpriceedit) as a side panel, so an unsaved sale
       is never at risk just from opening it; the panel shows the average purchase price as a read-only
       label, with editable Purchase price / Extra cost boxes and no selling price at all. */
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

function click(el) { if (!el) return false; el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); return true; }
function type(el, value) { if (!el) return false; el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); return true; }
function change(el, value) { if (!el) return false; el.value = value; el.dispatchEvent(new win.Event('change', { bubbles: true })); return true; }
const $ = s => D.querySelector(s);

const run = async () => {
  for (let i = 0; i < 600 && !(win.ERP && win.ERP.fullyReady); i++) await sleep(25);
  const ERP = win.ERP, M = win.Money;
  check('AS0 app boots with no console errors', !!ERP && errors.length === 0, errors.slice(0, 2).join(' | '));

  const wh = win.WAREHOUSES.filter(w0 => w0.active !== false)[0].id;
  const sup = win.SUPPLIERS[0].id;
  const products = win.PRODUCTS.filter(p => p.active !== false);
  const pA = products[30], pB = products[31];

  /* ═══ A. no per-product pricing box of any kind on Add stock any more (§28, 2026-09-29) ═══ */
  ERP.Builder.start('receive'); await sleep(80);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pA.id); await sleep(60);
  type($('[data-fcline="qty"]'), '20');
  type($('[data-fcline="rate"]'), '3000');
  change($('[data-fcb="reason"]'), 'test receipt');
  await sleep(60);
  check('AS1 there is no per-product Extra cost box on Add stock any more',
    !$('[data-fcprod]') && !D.querySelector('.fcb-prodprice'));
  const cardHeadings=Array.from(D.querySelectorAll('.fcb-card .card-h h3')).map(h=>h.textContent);
  check('AS2 there is no "Charges & prices" card any more — just Notes',
    cardHeadings.indexOf('Notes')>-1 && cardHeadings.indexOf('Charges & prices')===-1, cardHeadings.join(' | '));

  /* ═══ B. saving keeps the purchase price on the LINE, and it blends into the stock's own average — the
     product's chosen purchase price / extra cost (set on the Prices screen) are never touched by a receipt ═══ */
  const chosenBeforeA = ERP.Inventory.averages(pA.id).override;
  const extraBeforeA = ERP.Inventory.extraFor(pA.id, wh);
  const before = ERP.StockDocs.all().length;
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS3 the receipt saved (one more stock document)', ERP.StockDocs.all().length === before + 1);
  const doc = ERP.StockDocs.all()[0];
  const line = doc ? ERP.StockDocs.items(doc.id)[0] : null;
  check('AS4 the line keeps the typed purchase price, 3000', !!line && line.unitCostP === M.toP(3000), line && String(line.unitCostP));
  check('AS5 the stock\'s recorded cost is the purchase price, 3000', ERP.Inventory.costOf(pA.id, wh) === M.toP(3000));
  check('AS6 the product\'s chosen purchase price (if any) and extra cost are exactly what they were before this receipt',
    ERP.Inventory.averages(pA.id).override === chosenBeforeA && ERP.Inventory.extraFor(pA.id, wh) === extraBeforeA);

  /* ═══ C. same for Purchases → Receive stock: no per-product box, purchase price stays on the line ═══ */
  ERP.Builder.start('purchase'); await sleep(80);
  change($('[data-fcb="supplierId"]'), sup); await sleep(30);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pB.id); await sleep(60);
  type($('[data-fcline="qty"]'), '10');
  type($('[data-fcline="rate"]'), '2000');
  check('AS7 the purchase screen has no per-product pricing box either',
    !$('[data-fcprod]') && !D.querySelector('.fcb-prodprice'));
  const before2 = ERP.Purchases.all().length;
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS8 the purchase saves', ERP.Purchases.all().length === before2 + 1);
  check('AS9 what a sale is costed at now follows the live average (2,000) — nothing chosen on the Prices screen yet',
    ERP.Inventory.saleBuyOf(pB.id, wh) === M.toP(2000), String(ERP.Inventory.saleBuyOf(pB.id, wh)));

  /* ═══ D. the sale screen's rate cell: EDITABLE (no restriction), with an Edit button that opens the
     product Prices panel (a side panel — it must NOT touch the sale draft just by opening it) ═══ */
  const cust = win.CUSTOMERS[0];
  ERP.Builder.start('sale'); await sleep(80);
  change($('[data-fcb="customerId"]'), cust.id); await sleep(30);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pB.id); await sleep(60);
  const rateInput = $('[data-fcline="rate"]');
  const editBtn = $('[data-fcpriceedit]');
  check('D1 the sale rate is EDITABLE — no restriction (§28, 2026-09-29)', !!rateInput && rateInput.readOnly !== true);
  check('D2 the Edit button is still on the sale line, to open the product\'s Prices screen',
    !!editBtn && editBtn.dataset.fcpriceedit === pB.id);
  check('D3 the draft is dirty (a fresh unsaved line was just added)', ERP.Builder.dirty === true);
  check('D3b the cost label underneath shows the purchase price + extra cost, purely informational',
    /cost/i.test($('.fcb-costline')?.textContent || ''));

  type(rateInput, '50');   // far below the 2,000 cost — a deliberate loss, must not be refused
  await sleep(60);
  check('D3c the rate can be typed freely, including far below cost', rateInput.value === '50');

  click(editBtn); await sleep(120);
  check('D4 opening the Prices panel does NOT discard the unsaved sale', ERP.Builder.mode === 'sale' && ERP.Builder.dirty === true);
  check('D5 the Prices panel is actually open, for the right product',
    !!$('#panel.on') && D.body.textContent.indexOf(pB.en || pB.ur) > -1);
  check('D6 the panel shows the average purchase price as a read-only label, editable Purchase price / Extra ' +
    'cost boxes, and no selling price of any kind',
    D.querySelectorAll('#panel .pz-ro').length === 2 &&   /* average purchase price + average extra cost (carriage), §29 */
    !!$('#panel [data-f="buy"]') && !!$('#panel [data-f="extra"]') && !$('#panel [data-f="sell"]') &&
    !$('#panel [data-f="min"]') && !$('#panel [data-f="wholesale"]') && !$('#panel [data-f="reorder"]'));
  const closeBtn = $('#panel [data-close]');
  click(closeBtn); await sleep(60);
  check('D7 closing the panel leaves the sale exactly as it was, including the loss-making rate just typed',
    ERP.Builder.mode === 'sale' && ERP.Builder.dirty === true && $('[data-fcline="rate"]').value === '50');

  check('Z nothing threw during the session', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n' + out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
};
run();
