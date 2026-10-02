import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* The Product prices screen, as the client used it on 2026-09-26: purchase 6,000 + extra 200 = 6,200, sold 5 bags
   at 6,300, real profit 500 — the system showed 1,500 because the extra cost was never SAVED. Rebuilt again
   2026-09-29 (§28): the screen shows the average purchase price as a read-only LABEL, with editable
   Purchase price / Extra cost boxes (no selling price at all — that is now typed at the sale). Still true:
   (1) a reason is optional, (2) a Save that would store nothing says so inside the screen instead of closing it. */
const HTML=fs.readFileSync('dist/farooq-co-erp.html','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const out=[];
const check=(n,c,d)=>{if(c){pass++;out.push('  ✔ '+n);}else{fail++;out.push('  ✘ '+n+(d?'   → '+d:''));}};
const errors=[];
function boot(store){
  const vc=new VirtualConsole(); vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(HTML,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
   url:'https://x.local/e',beforeParse(w){
    w.indexedDB=store.idb; w.IDBKeyRange=FDBKeyRange; w.print=()=>{}; w.confirm=()=>true;
    w.prompt=()=>'not needed'; w.scrollTo=()=>{}; w.open=()=>null;
    w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
    w.HTMLElement.prototype.scrollIntoView=function(){};
    w.matchMedia=q=>({media:q,matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
   }});
  return dom.window;
}
async function ready(w){for(let i=0;i<400&&!(w.ERP&&w.ERP.ready);i++)await sleep(25);await sleep(350);return w.ERP;}

const run=async()=>{
  const store={idb:new FDBFactory()};
  const win=boot(store); const ERP=await ready(win);
  const M=win.Money, D=win.document;
  const $=s=>D.querySelector(s), $$=s=>Array.from(D.querySelectorAll(s));
  const click=el=>el&&el.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const type=(el,v)=>{if(el){el.value=v;el.dispatchEvent(new win.Event('input',{bubbles:true}));}};
  const wh=win.WAREHOUSES[1].id, P=win.PRODUCTS.filter(p=>p.active!==false);
  const X=P[3];
  const shop=win.CUSTOMERS[0].id, mill=win.SUPPLIERS[0].id;
  const box=k=>$('#panel [data-f="'+k+'"]');

  /* the client's day: buy 10 bags at 6,000, sell 5 at 6,300 with NO extra cost saved */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-26',
    items:[{productId:X.id,quantity:10,unitPrice:6000}]});
  const inv1=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-26',
    items:[{productId:X.id,quantity:5,unitPrice:6300}]});
  check('P1 with no extra cost saved the system shows 1,500 profit — it can only use what it was given',
    ERP.Profit.invoice(inv1.id).profit===M.toP(1500), M.fmt(ERP.Profit.invoice(inv1.id).profit));

  /* the screen opens with what the system already knows: the average purchase price as a read-only LABEL,
     the Purchase price box defaulting to that same average, and the Extra cost box defaulting to 0 — no
     selling price at all any more (§28, 2026-09-29). */
  ERP.openPriceEditor(X.id); await sleep(300);
  const roVals=()=>Array.from($('#panel').querySelectorAll('.pz-ro')).map(el=>el.textContent.trim());
  check('P2 the average purchase price is a read-only label showing the cost of the stock (6,000)', roVals()[0]==='PKR 6,000', roVals()[0]);
  check('P3 the Purchase price box defaults to that same average', box('buy').value==='6000', box('buy').value);
  check('P4 the Extra cost box defaults to blank/0 — nothing chosen yet', !box('extra').value || box('extra').value==='0', box('extra').value);
  check('P5 there is no selling price box on this screen at all', !box('sell'));
  check('P6 the reason box says it is optional', /Reason for the change \(optional\)/.test($('#panel').textContent));

  click($('#panel [data-close]')); await sleep(150);

  /* the calculation, written out — purchase + extra = total cost, nothing else (no selling price / profit
     here any more, that lives at the sale) */
  await ERP.Prices.set(X.id,{extra:200},{reason:'test — the extra cost'});
  ERP.openPriceEditor(X.id); await sleep(300);
  const rows=()=>$('#pzCalcRows').textContent;
  check('P7 the screen writes the sum: purchase 6,000, + extra 200, = total cost 6,200',
    /Purchase price\s*PKR 6,000/.test(rows()) && /\+ Extra cost \(carriage \/ transport\)\s*PKR 200/.test(rows()) && /= Total cost per bag\s*PKR 6,200/.test(rows()), rows());
  type(box('extra'),'350');
  check('P8 the live line follows the extra-cost box as it is typed', /= Total cost per bag\s*PKR 6,350/.test(rows()), rows());
  type(box('extra'),'200');

  /* Save with NO reason — the client's stumbling block. Nothing changed this time (extra already 200,
     purchase price already the average), so Save should say there is nothing to store. */
  click($('#panel [data-save]')); await sleep(300);
  check('P9 pressing Save with nothing actually changed says so, and needs no reason to say it',
    /Nothing to save/.test($('#panelErr').textContent), $('#panelErr').textContent);

  /* now actually choose a purchase price, with no reason typed at all */
  type(box('buy'),'6100');
  click($('#panel [data-save]')); await sleep(500);
  check('P10 Save stores the chosen purchase price even with an empty reason',
    ERP.Inventory.saleBuyOf(X.id,wh)===M.toP(6100), String(ERP.Inventory.saleBuyOf(X.id,wh)));
  check('P11 the change is in the price history, with an empty reason (the panel Save left it blank)',
    ERP.Prices.history(X.id).some(h=>h.field==='costOverride' && h.newValue===M.toP(6100) && (h.reason||'')===''));
  check('P12 the direct service call also accepts no reason at all',
    (await ERP.Prices.set(X.id,{min:6100},{})).applied===true);

  /* the whole point: the next sale now shows the client's own figures */
  const inv2=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-26',
    items:[{productId:X.id,quantity:5,unitPrice:6300}]});
  const pf=ERP.Profit.invoice(inv2.id);
  check('P13 after the purchase price + extra are chosen, 5 bags at 6,300 show revenue 31,500, cost 31,500 and profit 0',
    pf.revenue===M.toP(31500) && pf.cost===M.toP(31500) && pf.profit===0,
    [pf.revenue,pf.cost,pf.profit].map(M.fmt).join(' | '));
  check('P14 the first invoice keeps its own figure (1,500) — old invoices are not rewritten',
    ERP.Profit.invoice(inv1.id).profit===M.toP(1500));

  /* a Save that would store nothing, after the values are saved */
  ERP.openPriceEditor(X.id); await sleep(300);
  check('P15 reopened, the panel shows the saved figures — the chosen purchase price (6,100) and extra (200)',
    box('buy').value==='6100' && box('extra').value==='200', box('buy').value+' / '+box('extra').value);
  click($('#panel [data-save]')); await sleep(300);
  check('P16 pressing Save without changing anything says so inside the screen and stores nothing',
    /Nothing to save/.test($('#panelErr').textContent) &&
    ERP.Prices.history(X.id).filter(h=>h.field==='costOverride').length===1,
    $('#panelErr').textContent);

  /* Add stock asks what the bags COST — it opens with the average/chosen purchase price, never a selling
     price (there is no product-level selling price at all any more) */
  const pickInto=async(mode,prod)=>{
    ERP.Builder.start(mode); await sleep(120);
    click($('[data-fcbact="openpicker"]')); await sleep(60);
    type($('#fcbPick'),prod.en||prod.ur); await sleep(80);
    click($$('.fcb-res').find(b=>b.dataset.fcbadd===prod.id)||$('.fcb-res')); await sleep(80);
    return $('[data-fcline="rate"]');
  };
  let rateBox=await pickInto('receive',X);
  check('P18 Add stock opens with the CHOSEN purchase price (6,100) in its Cost box',
    !!rateBox && rateBox.value==='6100', rateBox&&rateBox.value);
  const Y=P[4];
  rateBox=await pickInto('receive',Y);
  check('P19 a product never purchased opens Add stock with an EMPTY cost box', !!rateBox && rateBox.value==='', rateBox&&rateBox.value);
  rateBox=await pickInto('sale',X);
  check('P20 a sale opens with the LAST rate this product actually sold at (6,300)', !!rateBox && rateBox.value==='6300', rateBox&&rateBox.value);
  check('P20b and the sale rate is editable, not read-only', !rateBox.readOnly);

  /* no empty stock row without a warehouse is created by reading a price, or stored by saving one */
  const Z=P[5];
  ERP.Prices.of(Z.id);
  await ERP.Prices.set(Z.id,{extra:200},{});
  await ERP.Prices.setCost(Z.id,{buy:6300,extra:200},{});
  check('P21 opening/saving prices for a product with no stock creates no "<product>|undefined" stock row',
    !Object.keys(ERP.S.inventory).some(k=>/undefined/.test(k)), Object.keys(ERP.S.inventory).filter(k=>/undefined/.test(k)).join(','));
  check('P17 nothing threw', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
