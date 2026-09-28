import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
/* The Product prices screen, as the client used it on 2026-09-26: purchase 6,000 + extra 200 = 6,200, sold 5 bags
   at 6,300, real profit 500 — the system showed 1,500 because the extra cost was never SAVED. Three things:
   (1) a reason is optional, (2) a Save that would store nothing says so inside the screen instead of closing it,
   (3) the screen opens with the values the system already knows and shows the sum written out. */
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

  /* the screen opens with what the system already knows. Purchase price / extra cost are now READ-ONLY
     text (§27, 2026-09-28 — fixed to the document that typed them); only the selling price is an input. */
  ERP.openPriceEditor(X.id); await sleep(300);
  const roVals=()=>Array.from($('#panel').querySelectorAll('.pz-ro')).map(el=>el.textContent.trim());
  check('P2 the purchase price shows the cost of the stock (6,000), not blank, read-only', roVals()[0]==='PKR 6,000', roVals()[0]);
  check('P3 the selling price box opens with the rate it last sold at (6,300) and says where that came from',
    box('sell').value==='6300' && /last sale/i.test($('#panel').textContent), box('sell').value);
  check('P4 the extra cost shows nothing — nothing is saved yet', roVals()[1]==='—', roVals()[1]);
  check('P5 the reason box says it is optional', /Reason for the change \(optional\)/.test($('#panel').textContent));

  click($('#panel [data-close]')); await sleep(150);

  /* the calculation, written out. The extra cost can no longer be typed on this screen — it is fixed to
     the purchase/receipt that carries it (here simulated the same way CLAUDE.md item 13 describes: "the
     first extra typed on a product with none covers stock already held", Prices.set's own pinning). */
  await ERP.Prices.set(X.id,{extra:200},{reason:'test — the extra cost, typed on a document in real life'});
  ERP.openPriceEditor(X.id); await sleep(300);
  const rows=$('#pzCalcRows').textContent;
  check('P7 the screen writes the sum: purchase 6,000, + extra 200, = total cost 6,200, selling 6,300, profit per bag 100',
    /Purchase price\s*PKR 6,000/.test(rows) && /\+ Extra cost\s*PKR 200/.test(rows) && /= Total cost per bag\s*PKR 6,200/.test(rows) &&
    /Selling price\s*PKR 6,300/.test(rows) && /Profit per bag\s*PKR 100/.test(rows), rows);
  type($('#panel [data-pzqty]'),'5');
  const tot=$('#pzCalcTot').textContent;
  check('P8 and with 5 bags: sale 5 × 6,300 = 31,500, cost 31,000, actual profit 500',
    /5 × PKR 6,300 = PKR 31,500/.test(tot) && /5 × PKR 6,200 = PKR 31,000/.test(tot) && /actual profit PKR 500/.test(tot), tot);
  type($('#panel [data-pzqty]'),'');
  check('P9 an empty bag count falls back to 1 bag rather than showing nonsense', /1 bag\b/.test($('#pzCalcTot').textContent), $('#pzCalcTot').textContent);
  type($('#panel [data-pzqty]'),'5');

  /* Save with NO reason — the client's stumbling block. Only the selling price is submitted now; it was
     already prefilled from the last sale (6,300), so Save just confirms it as the product's own figure. */
  type(box('sell'),'6300');
  click($('#panel [data-save]')); await sleep(500);
  const info=ERP.Prices.of(X.id);
  check('P10 Save stores the selling price; the extra cost (typed earlier, on the stock itself) already makes the true cost 6,200',
    info.sell===M.toP(6300) && ERP.Inventory.averages(X.id).cost+ERP.Inventory.averages(X.id).extra===M.toP(6200) &&
    ERP.Inventory.saleCostOf(X.id,wh)===M.toP(6200),
    `sell=${info.sell} cost+extra=${ERP.Inventory.averages(X.id).cost+ERP.Inventory.averages(X.id).extra} saleCost=${ERP.Inventory.saleCostOf(X.id,wh)}`);
  check('P11 the selling-price change is in the price history, with an empty reason (the panel Save left it blank)',
    ERP.Prices.history(X.id).some(h=>h.field==='sell' && h.newValue===M.toP(6300) && (h.reason||'')===''));
  check('P12 the direct call also accepts no reason at all',
    (await ERP.Prices.set(X.id,{min:6100},{})).applied===true);

  /* the whole point: the next sale now shows the client's own figure */
  const inv2=await ERP.Invoices.save({customerId:shop,warehouseId:wh,invoiceDate:'2026-09-26',
    items:[{productId:X.id,quantity:5,unitPrice:6300}]});
  const pf=ERP.Profit.invoice(inv2.id);
  check('P13 after the extra cost is saved, 5 bags at 6,300 show revenue 31,500, cost 31,000 and profit 500',
    pf.revenue===M.toP(31500) && pf.cost===M.toP(31000) && pf.profit===M.toP(500),
    [pf.revenue,pf.cost,pf.profit].map(M.fmt).join(' | '));
  check('P14 the first invoice keeps its own figure (1,500) — old invoices are not rewritten',
    ERP.Profit.invoice(inv1.id).profit===M.toP(1500));

  /* a Save that would store nothing, after the values are saved */
  ERP.openPriceEditor(X.id); await sleep(300);
  check('P15 reopened, the panel shows the saved figures — purchase/extra read-only (6,000 / 200), selling price editable (6,300)',
    roVals()[0]==='PKR 6,000' && roVals()[1]==='PKR 200' && box('sell').value==='6300',
    [roVals()[0],roVals()[1],box('sell').value].join(' / '));
  click($('#panel [data-save]')); await sleep(300);
  check('P16 pressing Save without changing anything says so inside the screen and stores nothing',
    /Nothing to save/.test($('#panelErr').textContent) && ERP.Prices.history(X.id).filter(h=>h.field==='extra').length===1,
    $('#panelErr').textContent);
  /* Add stock asks what the bags COST — it used to open with the SELLING price (6300 kept as the stock cost → a loss) */
  const pickInto=async(mode,prod)=>{
    ERP.Builder.start(mode); await sleep(120);
    click($('[data-fcbact="openpicker"]')); await sleep(60);
    type($('#fcbPick'),prod.en||prod.ur); await sleep(80);
    click($$('.fcb-res').find(b=>b.dataset.fcbadd===prod.id)||$('.fcb-res')); await sleep(80);
    return $('[data-fcline="rate"]');
  };
  const $$=s=>Array.from(D.querySelectorAll(s));
  let rateBox=await pickInto('receive',X);
  check('P18 Add stock opens with the saved PURCHASE price (6,000) in its Cost box, not the selling price (6,300)',
    !!rateBox && rateBox.value==='6000', rateBox&&rateBox.value);
  const Y=P[4];
  await ERP.Prices.set(Y.id,{sell:6300},{});
  rateBox=await pickInto('receive',Y);
  check('P19 a product with only a selling price saved opens Add stock with an EMPTY cost (never the selling price)',
    !!rateBox && rateBox.value==='', rateBox&&rateBox.value);
  rateBox=await pickInto('sale',X);
  check('P20 a sale still opens with the selling price (6,300)', !!rateBox && rateBox.value==='6300', rateBox&&rateBox.value);
  /* no empty stock row without a warehouse is created by reading a price, or stored by saving one */
  const Z=P[5];
  ERP.Prices.of(Z.id);
  await ERP.Prices.set(Z.id,{extra:200,sell:6300},{});
  check('P21 opening/saving prices for a product with no stock creates no "<product>|undefined" stock row',
    !Object.keys(ERP.S.inventory).some(k=>/undefined/.test(k)), Object.keys(ERP.S.inventory).filter(k=>/undefined/.test(k)).join(','));
  check('P17 nothing threw', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
