import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* The product's "Extra cost per bag" is part of what a SALE costs. Client, 2026-09-25:
   "purchase price 3000, extra cost 200, total 3200 — and profit showed 200 [more]". The Product prices
   panel already used 3,200, but invoices, the live profit line and the Profit report costed a sale at
   the stock cost (3,000) alone. Stock value and the stock average must NOT carry the extra. */
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
  const M=win.Money;
  const wh=win.WAREHOUSES[1].id, P=win.PRODUCTS.filter(p=>p.active!==false);
  const X=P[3], Y=P[4];
  const shop=win.CUSTOMERS[0].id, mill=win.SUPPLIERS[0].id;

  /* the client's own numbers */
  await ERP.Prices.set(X.id,{buy:3000,extra:200,sell:3400},{reason:'Client example'});
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-20',
    items:[{productId:X.id,quantity:100,unitPrice:3000}]});
  check('X1 the stock itself is still valued at what was paid for it (3,000) — the extra is not stock cost',
    ERP.Inventory.costOf(X.id,wh)===M.toP(3000), M.fmt(ERP.Inventory.costOf(X.id,wh)));
  check('X2 a sale is costed at purchase + extra = 3,200',
    ERP.Inventory.saleCostOf(X.id,wh)===M.toP(3200) && ERP.Cost.forSale(X.id,wh)===M.toP(3200),
    M.fmt(ERP.Inventory.saleCostOf(X.id,wh)));
  check('X3 the Product prices panel and a sale now agree on the cost to us',
    ERP.Prices.of(X.id).totalCost===ERP.Cost.forSale(X.id,wh));

  const pv=ERP.Profit.preview(X.id,wh,10,3400,0);
  check('X4 the live line on the invoice: 10 bags at 3,400 cost 32,000 and earn 2,000 (200 a bag, not 400)',
    pv.cost===M.toP(3200) && pv.totalCost===M.toP(32000) && pv.profit===M.toP(2000) && pv.extra===M.toP(200),
    `${M.fmt(pv.cost)} ${M.fmt(pv.profit)} ${M.fmt(pv.extra)}`);
  const at3200=ERP.Profit.preview(X.id,wh,10,3200,0);
  check('X5 selling at exactly 3,200 is no profit at all',
    at3200.profit===0 && !at3200.belowCost, M.fmt(at3200.profit));
  const at3100=ERP.Profit.preview(X.id,wh,10,3100,0);
  check('X6 selling at 3,100 — above the mill price but under the cost to us — is flagged below cost',
    at3100.belowCost===true && at3100.profit===M.toP(-1000), M.fmt(at3100.profit));

  /* the note drawn under the rate while typing */
  const savedB=ERP.Builder;
  ERP.Builder={cfg:{party:'customer',rates:true},draft:{warehouseId:wh,items:[{productId:X.id,warehouseId:wh,quantity:'10',unitPrice:'3400',discount:''}]}};
  const note=(ERP.marginNote(0)||'').replace(/<[^>]+>/g,'');
  ERP.Builder=savedB;
  check('X7 the invoice note shows the cost broken down (stock + extra) and the true profit',
    /PKR 3,200/.test(note) && /stock PKR 3,000 \+ extra PKR 200/.test(note) && /profit PKR 2,000/.test(note), note);

  const inv=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-25',
    items:[{productId:X.id,quantity:10,unitPrice:3400}]});
  const line=ERP.Invoices.items(inv.id)[0];
  check('X8 the saved invoice line keeps the cost of the day: 3,200', line.costSnapshot===M.toP(3200), M.fmt(line.costSnapshot));
  const pf=ERP.Profit.invoice(inv.id);
  check('X9 the invoice\'s profit is 2,000 (34,000 − 32,000)',
    pf.revenue===M.toP(34000) && pf.cost===M.toP(32000) && pf.profit===M.toP(2000),
    [pf.revenue,pf.cost,pf.profit].map(M.fmt).join(' | '));
  const rep=ERP.Profit.report('2026-09-25','2026-09-25',{by:'product'});
  check('X10 the Profit report agrees', rep.totals.profit===M.toP(2000), M.fmt(rep.totals.profit));
  check('X11 the stock average is untouched by the sale (still 3,000)', ERP.Inventory.costOf(X.id,wh)===M.toP(3000));

  await ERP.Prices.set(X.id,{extra:500},{reason:'Transport went up'});
  check('X12 raising the extra later does not rewrite that invoice\'s profit',
    ERP.Profit.invoice(inv.id).profit===M.toP(2000), M.fmt(ERP.Profit.invoice(inv.id).profit));
  /* §28, 2026-09-29 (client: "extra cost… by default extra is 0… but when the user changes it the new
     value will always be there even when new products are added"): the extra is now ONE figure per
     PRODUCT, not pinned per warehouse row — raising it reaches the bags already on the shelf immediately. */
  check('X13 the 90 bags already in stock are costed at the NEW extra immediately (500) — nothing is pinned per row any more',
    ERP.Cost.forSale(X.id,wh)===M.toP(3500), M.fmt(ERP.Cost.forSale(X.id,wh)));
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-25',
    items:[{productId:X.id,quantity:90,unitPrice:3000}]});
  check('X13b 90 more bags at the same purchase price change nothing about the cost — the extra stays the one current figure (3,500)',
    ERP.Cost.forSale(X.id,wh)===M.toP(3500), M.fmt(ERP.Cost.forSale(X.id,wh)));

  /* no extra → nothing changes */
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-20',
    items:[{productId:Y.id,quantity:50,unitPrice:2000}]});
  check('X14 a product with no extra cost is costed exactly as before',
    ERP.Inventory.saleCostOf(Y.id,wh)===ERP.Inventory.costOf(Y.id,wh) && ERP.Inventory.costOf(Y.id,wh)===M.toP(2000));

  /* the owner's "purchase price only" profit basis leaves the extra out */
  await ERP.Settings.save({profitCostBasis:'PURCHASE'});
  check('X15 with profit worked on purchase price only, the extra is left out', ERP.Cost.forSale(X.id,wh)===M.toP(3000),
    M.fmt(ERP.Cost.forSale(X.id,wh)));
  await ERP.Settings.save({profitCostBasis:'LANDED'});
  check('X16 and back on the landed basis it is included again', ERP.Cost.forSale(X.id,wh)===M.toP(3500));

  /* an unknown stock cost stays unknown — the extra alone is not a cost price */
  const Z=P.find(p=>p.id!==X.id && p.id!==Y.id && !ERP.Inventory.costOf(p.id,wh) && !(p.buy>0) && !(p.buyP>0));
  if(Z){
    win.prodOf(Z.id).extraP=M.toP(150); win.prodOf(Z.id).extra=150;
    check('X17 with no purchase cost known, a sale is not costed at the extra alone (profit stays "unknown")',
      ERP.Inventory.saleCostOf(Z.id,wh)===0 && ERP.Profit.preview(Z.id,wh,1,1000,0).known===false);
  } else {
    check('X17 a product with no cost exists in the seed data to test the unknown-cost case', false);
  }

  /* the double-count trap: freight already on a purchase (Landed costs) + an extra cost per bag */
  const W=P.find(p=>![X.id,Y.id,Z&&Z.id].includes(p.id));
  await ERP.Purchases.save({supplierId:mill,warehouseId:wh,purchaseDate:'2026-09-21',freight:10000,
    items:[{productId:W.id,quantity:100,unitPrice:2000}]});
  const D=win.document, $=s=>D.querySelector(s);
  /* the price panel itself was simplified 2026-09-28 (§26) and no longer shows the old "these bags already
     carry transport" banner (the Charges & payment card it belonged to is gone from Purchases too) — but
     the underlying landedAlready/landedBreakdown functions it was built on are unchanged, and still say
     whether this product's stock already carries Landed-cost transport. */
  ERP.openPriceEditor(W.id); await sleep(300);
  check('X19 landedAlready still reports transport already carried through Landed costs',
    ERP.Prices.landedAlready(W.id)===true, String(ERP.Prices.landedAlready(W.id)));
  check('X19b the panel still opens for that product without throwing, showing its averages (read-only, §27)',
    !!$('#panel .pz-ro') && $('#panel .pz-ro').textContent.trim()!=='' && $('#panel .pz-ro').textContent.trim()!=='—');
  ERP.openPriceEditor(X.id); await sleep(300);
  check('X20 no such warning for a product bought without charges', ERP.Prices.landedAlready(X.id)===false);
  await ERP.Settings.save({profitCostBasis:'PURCHASE'});
  check('X21 nor on the purchase-price-only basis (the extra is not added there)', ERP.Prices.landedAlready(W.id)===false);
  await ERP.Settings.save({profitCostBasis:'LANDED'});

  check('X18 nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
