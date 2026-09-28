/* Add stock (Inventory → Add stock, Builder mode "receive") gained two fields in the Sept 2026
   purchase-screen overhaul: "Extra charges / bag" and "Selling price / bag". Neither was actually wired
   up (2026-09-28 review): the `input` event handler in 06-wiring.js had no case for either key, so typing
   into them never even reached the draft — Save silently discarded whatever was typed. This file covers
   the fix:
     - typing in either field reaches ERP.Builder.draft;
     - "Extra charges / bag" is folded into the cost of every line and actually raises the recorded stock
       cost, the same way freight/loading would on a purchase;
     - a product that already carries its own "Extra cost per bag" (Prices screen) is warned about before
       the same transport gets counted twice, mirroring Purchases.doubleCostWarning;
     - "Selling price / bag" is written to the product through ERP.Prices.set.
   It also covers the sale screen's "Change price — edit the purchase" pencil (§25, prices are read-only
   at the POS): it rendered on every sale line but had no click handler anywhere in the app. */
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
  const pA = products[30], pB = products[31], pExtra = products[32];

  /* known baselines — the seed catalogue may already carry prices that would make a validation
     (selling below cost, below a saved minimum) fail for reasons unrelated to what is being tested */
  await ERP.Prices.set(pA.id, { buy: '1000', min: '' }, { reason: 'test baseline' }).catch(() => {});
  await ERP.Prices.set(pB.id, { buy: '1000', min: '' }, { reason: 'test baseline' }).catch(() => {});
  /* pExtra already has its own "Extra cost per bag" saved — the double-cost trap */
  await ERP.Prices.set(pExtra.id, { buy: '1000', extra: '150', min: '' }, { reason: 'test baseline' }).catch(() => {});

  /* ═══ A. typing reaches the draft (the actual bug: neither field was in the input allowlist) ═══ */
  ERP.Builder.start('receive'); await sleep(80);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pA.id); await sleep(60);
  type($('[data-fcline="qty"]'), '20');
  type($('[data-fcline="rate"]'), '3000');
  change($('[data-fcb="reason"]'), 'test receipt');
  type($('[data-fcb="otherChargesPerBag"]'), '100');
  type($('[data-fcb="sellingPrice"]'), '4000');
  await sleep(60);
  check('AS1 "Extra charges / bag" reaches the draft', ERP.Builder.draft.otherChargesPerBag === '100');
  check('AS2 "Selling price / bag" reaches the draft', ERP.Builder.draft.sellingPrice === '4000');

  /* ═══ B. saving folds the extra into the recorded cost, and sets the selling price ═══ */
  const before = ERP.StockDocs.all().length;
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS3 the receipt saved (one more stock document)', ERP.StockDocs.all().length === before + 1);
  const doc = ERP.StockDocs.all()[0];
  const line = doc ? ERP.StockDocs.items(doc.id)[0] : null;
  check('AS4 the line was costed at 3000 + 100 extra = 3100, not 3000',
    !!line && line.unitCostP === M.toP(3100), line && String(line.unitCostP));
  check('AS5 the stock carries that cost', ERP.Inventory.carriedCost(pA.id, wh) === M.toP(3100));
  await sleep(80);
  check('AS6 the selling price was saved to the product',
    (ERP.Prices.of(pA.id) || {}).sell === M.toP(4000), JSON.stringify(ERP.Prices.of(pA.id)));

  /* ═══ C. the double-cost warning (a product with its own Extra cost per bag) ═══ */
  ERP.Builder.start('receive'); await sleep(80);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pExtra.id); await sleep(60);
  type($('[data-fcline="qty"]'), '10');
  type($('[data-fcline="rate"]'), '2000');
  change($('[data-fcb="reason"]'), 'test receipt 2');
  type($('[data-fcb="otherChargesPerBag"]'), '50');
  await sleep(60);
  const before2 = ERP.StockDocs.all().length;
  click($('[data-fcbact="save"]')); await sleep(150);
  check('AS7 the first Save is refused — same transport would be counted twice',
    ERP.StockDocs.all().length === before2 && /counts the same transport twice/i.test(D.body.textContent));
  click($('[data-fcbact="save"]')); await sleep(250);
  check('AS8 pressing Save again keeps it (the person’s call)', ERP.StockDocs.all().length === before2 + 1);

  /* ═══ D. the sale screen's "edit the purchase" pencil — rendered, but had no click handler at all ═══ */
  const pu = await ERP.Purchases.save({ supplierId: sup, warehouseId: wh, purchaseDate: '2026-09-20',
    items: [{ productId: pB.id, quantity: 50, unitPrice: 2500 }] });
  const cust = win.CUSTOMERS[0];
  ERP.Builder.start('sale'); await sleep(80);
  change($('[data-fcb="customerId"]'), cust.id); await sleep(30);
  change($('[data-fcb="warehouseId"]'), wh); await sleep(30);
  ERP.BuilderUI.addLine(pB.id); await sleep(60);
  const editBtn = $('[data-fcpuredirect]');
  check('AS9 the pencil is on the sale line', !!editBtn);
  check('AS10 the draft is dirty (a fresh unsaved line was just added)', ERP.Builder.dirty === true);

  win.confirm = () => false;   /* "Keep editing" */
  click(editBtn); await sleep(100);
  check('AS11 declining the "unsaved sale" warning keeps the sale draft open', ERP.Builder.mode === 'sale');

  win.confirm = () => true;    /* "Discard and continue" */
  click(editBtn); await sleep(150);
  check('AS12 confirming opens the purchase that priced this product',
    ERP.Builder.mode === 'purchase' && ERP.Builder.editingId === pu.id,
    ERP.Builder.mode + ' / ' + ERP.Builder.editingId);

  check('Z nothing threw during the session', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log('\n' + out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
};
run();
