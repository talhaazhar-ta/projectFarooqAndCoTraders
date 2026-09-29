import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* §28, 2026-09-29 (client): "no need of extra cost while purchasing or adding stock — extra cost of the
   product will be decided [on the Prices screen]… while selling, label the purchase price + extra cost set
   there, by default extra is 0 and purchase price is the average, but when the user changes it the new value
   will always be there even when new products are added". This SUPERSEDES the 2026-09-26 design this file
   used to cover (each stock ROW carrying its own moving-average `avgExtraP`, pinned bag-by-bag as new stock
   arrived at a different figure — see docs/AVG_PRICING.md history). Extra cost is now ONE figure per
   PRODUCT (`p.extraP`, `Inventory.rawExtraOf`/`extraFor`), typed once on the Prices screen, and a change to
   it takes effect on every bag immediately — nothing pins it per warehouse row any more. The old row-level
   `avgExtraP` blending machinery (`Inventory.apply`) is left in place for movement-history bookkeeping
   (`rowExtraP`, stock-receipt edits, reversals) but is no longer read for what a sale is costed at. */
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
  const M=win.Money, R=M.toP, SD=ERP.StockDocs;
  const whs=win.WAREHOUSES.filter(x=>x.active!==false), wh=whs[1].id;
  const P=win.PRODUCTS.filter(p=>p.active!==false);
  const shop=win.CUSTOMERS[0].id, mill=win.SUPPLIERS[0].id;
  const setExtra=(p,x)=>ERP.Prices.set(p.id,{extra:x},{reason:'transport rate changed'});
  const buy=(p,q,price,date)=>ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:date||'2026-09-20',
    items:[{productId:p.id,quantity:q,unitPrice:price}]});
  const sell=(p,q)=>ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-25',
    items:[{productId:p.id,quantity:q,unitPrice:9000}]});
  const cost=(p,w)=>ERP.Cost.forSale(p.id,w||wh);

  /* ═══ A. the extra cost is a single per-product figure; changing it moves EVERY bag's sale cost at once,
     not just the next lot ═══ */
  const A=P[5];
  await ERP.Prices.set(A.id,{buy:3000,extra:200},{reason:'setup'});
  await buy(A,100,3000);
  check('A1 100 bags bought with an extra of 200 cost 3,200 to sell', cost(A)===R(3200), M.fmt(cost(A)));
  await setExtra(A,300);
  check('A2 the extra is now 300 — it applies to the SAME 100 bags immediately, no per-row pinning any more',
    cost(A)===R(3300), M.fmt(cost(A)));
  await buy(A,100,3000);
  check('A3 200 more bags at the same purchase price — the cost is still purchase + the one current extra (3,300)',
    cost(A)===R(3300), M.fmt(cost(A)));
  check('A4 stock value and the purchase-price average never carry the extra (3,000)',
    ERP.Inventory.costOf(A.id,wh)===R(3000));

  /* ═══ B. sales do not move it; an already-issued invoice keeps its own snapshot even after the extra
     later changes ═══ */
  const inv=await sell(A,60);
  check('B1 60 bags sold: costed at the extra in force that day (300) → 3,300',
    ERP.Invoices.items(inv.id)[0].costSnapshot===R(3300), M.fmt(ERP.Invoices.items(inv.id)[0].costSnapshot));
  await setExtra(A,400);
  check('B2 the CURRENT cost follows the new extra (3,400) — nothing pins the old bags any more',
    cost(A)===R(3400), M.fmt(cost(A)));
  check('B3 but the earlier invoice keeps its own snapshot from the day it was made (3,300)',
    ERP.Invoices.items(inv.id)[0].costSnapshot===R(3300));

  /* ═══ C. Add stock and a stock receipt never carry an extra of their own any more — they only move
     quantity; the product's own extra (set on the Prices screen) is what a sale reads ═══ */
  const H=P[11];
  await ERP.Prices.set(H.id,{extra:100},{reason:'setup'});
  await SD.receive({warehouseId:wh,date:'2026-09-05',reason:'count',items:[{productId:H.id,quantity:30,unitPrice:1500}]});
  check('C1 a receipt with no extra box at all costs the bags at the product\'s current extra (100) → 1,600',
    cost(H)===R(1600), M.fmt(cost(H)));
  await setExtra(H,300);
  check('C2 changing the extra afterwards moves the SAME bags immediately → 1,800', cost(H)===R(1800), M.fmt(cost(H)));

  /* ═══ D. the profit basis still switches it off entirely, and back on ═══ */
  await ERP.Settings.save({profitCostBasis:'PURCHASE'});
  check('D1 on the "purchase price only" basis the extra is left out', cost(A)===R(3000));
  await ERP.Settings.save({profitCostBasis:'LANDED'});
  check('D2 back on landed it is there again, at whatever the extra is now (400)', cost(A)===R(3400));

  /* ═══ E. bulk "Change many prices" still sets the extra on several products at once, and it is
     immediately what a sale reads for every one of them ═══ */
  const E1=P[7], E2p=P[8];
  await buy(E1,10,1000); await buy(E2p,10,1000);
  await ERP.MasterEdit.bulkPrice([E1.id,E2p.id],{field:'extra',mode:'set',amount:75},'Fuel surcharge');
  check('E1 a bulk extra-cost change applies to both products immediately',
    cost(E1)===R(1075) && cost(E2p)===R(1075), M.fmt(cost(E1))+' / '+M.fmt(cost(E2p)));

  check('Z nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
