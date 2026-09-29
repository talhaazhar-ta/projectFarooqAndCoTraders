import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* The purchase screen, in the owner's own words (2026-09-26): "what do I write in Rate? is the discount for each product?
   what is the overall discount? are Delivery / Loading / Other for each bag or the whole purchase? why does 200 show as 40?"
   Answers, as the system really works — and what each bag then costs:
     Rate = price of ONE bag · line Discount = money off that whole line · Overall discount = money off the whole purchase ·
     Delivery / Loading / Other = totals for the whole purchase (spread over the bags: 200 ÷ 5 bags = 40) · Amount paid = for the whole purchase.
   Bug fixed here: the overall discount lowered the bill but NOT the cost of each bag. */
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
  const $=s=>D.querySelector(s);
  const click=el=>el&&el.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const type=(el,v)=>{if(el){el.value=v;el.dispatchEvent(new win.Event('input',{bubbles:true}));}};
  const wh=win.WAREHOUSES[1].id, P=win.PRODUCTS.filter(p=>p.active!==false);
  const A=P[3], B=P[4], C=P[5];
  const mill=win.SUPPLIERS[0].id;

  /* ── charges are totals for the whole purchase, shared over the bags ── */
  const pC=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-26',otherCharges:200,items:[{productId:A.id,quantity:5,unitPrice:6000}]});
  const itC=ERP.Purchases.items(pC.id)[0];
  check('C1 200 typed under Other charges for 5 bags is 40 per bag (not 200): each bag costs 6,040',
    itC.chargeShare===M.toP(200) && itC.landedUnitCost===M.toP(6040), M.fmt(itC.landedUnitCost));
  check('C2 the supplier bill is 30,000 + 200 = 30,200 (the charges are on the same bill)', pC.grandTotal===M.toP(30200), M.fmt(pC.grandTotal));

  /* ── the overall discount must lower the cost of every bag (it used to lower only the bill) ── */
  const pD=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-26',invoiceDiscount:500,otherCharges:200,items:[{productId:B.id,quantity:5,unitPrice:6000}]});
  const itD=ERP.Purchases.items(pD.id)[0];
  check('D1 the bill is 30,000 − 500 + 200 = 29,700', pD.grandTotal===M.toP(29700), M.fmt(pD.grandTotal));
  check('D2 each bag costs 5,940: 6,000 − 100 (500 ÷ 5) + 40 (200 ÷ 5) — the discount is in the cost, not only in the bill',
    itD.goodsUnitCost===M.toP(5900) && itD.landedUnitCost===M.toP(5940), M.fmt(itD.goodsUnitCost)+' / '+M.fmt(itD.landedUnitCost));
  check('D3 the stock\'s recorded cost follows: 5,940', ERP.Inventory.costOf(B.id,wh)===M.toP(5940), M.fmt(ERP.Inventory.costOf(B.id,wh)));

  /* a discount on a LINE is money off that whole line, and is already in the cost */
  const pL=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-26',items:[{productId:C.id,quantity:5,unitPrice:6000,discount:500}]});
  const itL=ERP.Purchases.items(pL.id)[0];
  check('L1 a line discount of 500 on 5 bags is 100 off each bag (500 for the whole line): bill 29,500, each bag 5,900',
    pL.grandTotal===M.toP(29500) && itL.landedUnitCost===M.toP(5900), M.fmt(pL.grandTotal)+' / '+M.fmt(itL.landedUnitCost));

  /* two products: the charges and the overall discount are shared by value */
  const pT=await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-26',invoiceDiscount:1000,otherCharges:400,
    items:[{productId:P[6].id,quantity:10,unitPrice:5000},{productId:P[7].id,quantity:10,unitPrice:3000}]});
  const [i1,i2]=ERP.Purchases.items(pT.id);
  /* goods 50,000 + 30,000 = 80,000 ; discount 1,000 → 625 / 375 ; charges 400 → 250 / 150 */
  check('T1 two products: the discount (−1,000) and charges (+400) are shared by value — bags cost 4,962.5→4,963 and 2,977.5→2,978 (rounded)',
    Math.abs(i1.landedUnitCost-M.toP(4962.5))<=1 && Math.abs(i2.landedUnitCost-M.toP(2977.5))<=1, M.fmt(i1.landedUnitCost)+' / '+M.fmt(i2.landedUnitCost));

  /* ── the purchase screen, simplified further (§28, 2026-09-29): no more Overall discount / Delivery /
     Loading / Other charges boxes, no line Discount column, and — new — no more per-product Extra cost box
     either: just the purchase price on the line. Extra cost is now chosen once, on the product's own Prices
     screen. ── */
  ERP.Builder.start('purchase'); await sleep(250);
  const view=()=>$('#view').textContent.replace(/\s+/g,' ');
  check('S1 the old charge boxes are gone from the screen',
    !/Overall discount/.test(view()) && !/Delivery \/ freight/.test(view()) && !/Loading \/ unloading/.test(view()));
  check('S2 the items table has no Discount column any more', !$('#view th')||!Array.from(D.querySelectorAll('#view th')).some(th=>th.textContent.trim()==='Discount'));
  const rateHead=Array.from(D.querySelectorAll('#view th')).find(th=>/Purchase price/.test(th.textContent));
  check('S3 the price column is labelled "Purchase price" (not "Rate") with an "i" beside it',
    !!rateHead && !!rateHead.querySelector('[data-fcinfo]'));

  const Bd=ERP.Builder.draft; Bd.supplierId=mill; Bd.warehouseId=wh;
  win.ERP.BuilderUI.addLine(P[8].id); await sleep(150);
  Bd.items[0].quantity='5'; Bd.items[0].unitPrice='6000';
  check('S4 there is no per-product pricing box of any kind on this screen any more (§28, 2026-09-29)',
    !$('[data-fcprod]') && !D.querySelector('.fcb-prodprice'));

  const saidMsgs=[]; win.say=m=>saidMsgs.push(m);
  const savedPu=await new Promise(res=>{
    const origSave=ERP.Purchases.save;
    ERP.Purchases.save=function(d){ ERP.Purchases.save=origSave; return origSave.call(ERP.Purchases,d).then(r=>{res(r);return r;}); };
    click($('[data-fcbact="save"]'));
  });
  await sleep(80);
  check('S5 the purchase saves with just the line\'s own purchase price', !!savedPu);
  const savedItem=ERP.Purchases.items(savedPu.id)[0];
  check('S6 the line keeps the purchase price (6,000)', savedItem.unitPrice===M.toP(6000), String(savedItem.unitPrice));
  check('S7 the stock\'s own average is now 6,000 — a sale is costed at that average until a price is chosen on the Prices screen',
    ERP.Inventory.saleBuyOf(P[8].id,wh)===M.toP(6000) && ERP.Inventory.averages(P[8].id).override===0);

  /* ── the product's Prices screen: the average purchase price is a read-only LABEL, with editable
     "Purchase price" and "Extra cost per bag" boxes below it (§28, 2026-09-29) — no selling price on this
     screen at all. The purchase itself is still listed with an Edit link. ── */
  ERP.openPriceEditor(A.id); await sleep(300);
  const roVals=()=>Array.from(D.querySelectorAll('#panel .pz-ro')).map(el=>el.textContent.trim());
  check('P1 "Average purchase price (stock on hand)" reflects the stock on hand — 6,040, A\'s earlier purchase with charges — shown as a plain label',
    roVals()[0]==='PKR 6,040', roVals().join(' / '));
  check('P1b the Purchase price box defaults to that same average, and there is no Selling price box at all',
    $('#panel [data-f="buy"]').value===String(6040) && !$('#panel [data-f="sell"]'), $('#panel [data-f="buy"]').value);
  type($('#panel [data-f="buy"]'),'6300');
  const rows=()=>$('#pzCalcRows').textContent.replace(/\s+/g,' ');
  check('P2 typing a chosen purchase price of 6,300 updates the live "cost to us" line',
    /Total cost per bag\s*PKR 6,300/.test(rows()), rows());
  D.querySelector('#panel [data-f="reason"]').value='Owner chose a price';
  click(D.querySelector('#panel [data-save]')); await sleep(300);
  check('P2b Save stores it — a sale is now costed at 6,300, not the 6,040 average',
    ERP.Inventory.saleBuyOf(A.id,wh)===M.toP(6300), String(ERP.Inventory.saleBuyOf(A.id,wh)));
  ERP.openPriceEditor(A.id); await sleep(300);   // fresh — nothing typed, so the Edit link below is free to navigate
  check('P3 the "Use the average" button appears once a price is chosen', !!D.querySelector('[data-pzuseavg]'));
  const txRows=Array.from(D.querySelectorAll('#panel .pz-h'));
  check('P4 the purchase that priced this product is listed, with an Edit link',
    txRows.some(r=>/PUR-/.test(r.textContent)) && !!D.querySelector('#panel [data-pztxedit="purchase"]'));
  let openedPu=null; const realEdit=win.ERP.actions.editPurchase; win.ERP.actions.editPurchase=id=>{openedPu=id;};
  click(D.querySelector('#panel [data-pztxedit="purchase"]'));
  win.ERP.actions.editPurchase=realEdit;
  check('P5 pressing Edit on a purchase row opens that purchase for editing', !!openedPu && !!ERP.Purchases.byId(openedPu));
  ERP.openPriceEditor(A.id); await sleep(300);
  const nothing=win.PANELS.prices.save({});
  check('P6 pressing Save with nothing changed says so', typeof nothing==='string' && /Nothing to save/.test(nothing), String(nothing));
  check('X nothing threw', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
