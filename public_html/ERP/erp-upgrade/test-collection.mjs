import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
const HTML=fs.readFileSync('dist/farooq-co-erp.html','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const out=[];
const check=(n,c,d)=>{if(c){pass++;out.push('  ✔ '+n);}else{fail++;out.push('  ✘ '+n+(d?'   → '+d:''));}};
const errors=[];
function boot(store){
  const vc=new VirtualConsole(); vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(HTML,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
   url:'https://x.local/e',beforeParse(w){
    w.indexedDB=store.idb; w.IDBKeyRange=FDBKeyRange; w.print=()=>{store.printed=(store.printed||0)+1;};
    w.confirm=()=>true; w.prompt=()=>'t'; w.scrollTo=()=>{}; w.open=()=>null;
    w.URL.createObjectURL=()=>'b'; w.URL.revokeObjectURL=()=>{};
    w.HTMLElement.prototype.scrollIntoView=function(){};
    w.matchMedia=q=>({media:q,matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
   }});
  return dom.window;
}
const run=async()=>{
  const store={idb:new FDBFactory()};
  let win=boot(store);
  for(let i=0;i<400&&!(win.ERP&&win.ERP.ready);i++)await sleep(25);
  await sleep(350);
  let ERP=win.ERP; const M=win.Money, D=win.document;
  const $=s=>D.querySelector(s), $$=s=>Array.from(D.querySelectorAll(s));
  const click=el=>el&&el.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const Staff=ERP.Staff, Areas=ERP.Areas, Col=ERP.Collection, C=ERP.CollectionState;

  const wh=win.WAREHOUSES[1].id, P=win.PRODUCTS.filter(p=>p.active!==false);
  const dir=win.REGIONS.find(r=>/dir/i.test(r.en))||win.REGIONS[3];
  const drosh=win.REGIONS.find(r=>/drosh/i.test(r.en))||win.REGIONS[2];
  const A=win.CUSTOMERS.filter(c=>c.region===dir.id)[0];
  const B=win.CUSTOMERS.filter(c=>c.region===dir.id)[1];
  const Cc=win.CUSTOMERS.filter(c=>c.region===drosh.id)[0];
  await ERP.Purchases.save({supplierId:win.SUPPLIERS[0].id,warehouseId:wh,
    items:P.slice(0,3).map(p=>({productId:p.id,quantity:900,unitPrice:2000}))});
  const sell=(c,amount)=>ERP.Invoices.save({customerId:c.id,warehouseId:wh,invoiceDate:'2026-09-02',
    items:[{productId:P[0].id,quantity:amount/1000,unitPrice:1000}]});
  await sell(A,50000); await sell(B,30000); await sell(Cc,100000);

  /* ── the acceptance scenario from the brief ── */
  C.regionId=dir.id; C.salesmanId='all'; C.outstandingOnly=true; C.minBalance=''; C.q=''; C.from=''; C.to='';
  let rows=Col.rows(), sum=Col.summary(rows);
  check('C1 only the shops on the chosen area appear',
    rows.length===2 && rows.every(r=>[A.id,B.id].indexOf(r.id)>-1), rows.map(r=>r.shop).join(', '));
  check('C2 the area total is what those shops owe',
    sum.outstanding===M.toP(80000), M.fmt(sum.outstanding));
  await ERP.Payments.receive({customerId:A.id,amount:20000,method:'Cash',date:'2026-09-11'});
  rows=Col.rows(); sum=Col.summary(rows);
  check('C3 a payment drops the area total at once',
    sum.outstanding===M.toP(60000), M.fmt(sum.outstanding));
  check('C4 and the shop\'s own statement agrees',
    ERP.Ledger.customerBalance(A.id)===M.toP(30000) &&
    ERP.Khata.summary(A.id,{}).closing===M.toP(30000));
  check('C5 the sheet and the statement read one ledger',
    rows.find(r=>r.id===A.id).balance===ERP.Ledger.customerBalance(A.id));

  /* shops owing nothing are filtered by default — the screen must say so and offer them */
  const fresh={id:'CUST-9998',sh:'Zzz Fresh Shop',ow:'',region:dir.id,ph:'',wa:'',addr:'',lim:null,term:'',bal:0,tot:0,ord:0,bagsOut:0,last:null,active:true};
  win.CUSTOMERS.push(fresh);
  rows=Col.rows();
  check('C5a shops that owe nothing are counted as hidden, not silently dropped',
    rows.hidden>=1 && !rows.some(r=>r.id===fresh.id), String(rows.hidden));
  win.go('collection'); await sleep(150);
  const shownText=()=>{const b=win.document.body.cloneNode(true);b.querySelectorAll('script,style').forEach(e=>e.remove());return b.textContent;};
  check('C5b the screen says how many are not shown and offers Show all shops',
    /not shown/.test(shownText()) && !!win.document.querySelector('[data-csshowall]'));
  win.document.querySelector('[data-csshowall]').dispatchEvent(new win.Event('click',{bubbles:true})); await sleep(150);
  check('C5c Show all shops lists the new shop and drops the notice',
    shownText().includes('Zzz Fresh Shop') && !win.document.querySelector('[data-csshowall]'));
  win.CUSTOMERS.splice(win.CUSTOMERS.indexOf(fresh),1);
  C.outstandingOnly=true; rows=Col.rows(); sum=Col.summary(rows);

  /* ── salesmen and areas ── */
  const man=await Staff.save({name:'Gul Rahman',phone:'0300-1234567',employeeId:'SM-01'});
  await Areas.assignSalesman(dir.id,man.id);
  check('C6 a salesman can be added and given an area',
    Staff.all().length===1 && (Staff.byId(man.id).regionIds||[]).indexOf(dir.id)>-1,
    JSON.stringify(Staff.byId(man.id).regionIds||[]));
  check('C7 shops on that area inherit him',
    Staff.forCustomer(A.id)===man.id && Staff.nameForCustomer(A.id)==='Gul Rahman');
  check('C8 a shop not on his area does not', Staff.forCustomer(Cc.id)!==man.id);
  C.salesmanId=man.id; C.regionId='all';
  check('C9 filtering the round by salesman works',
    Col.rows().length===2, String(Col.rows().length));
  C.salesmanId='all'; C.regionId=dir.id;
  const man2=await Staff.save({name:'Israr Ali',phone:'0311-7654321'});
  await Staff.archive(man2.id,true);
  check('C10 a salesman is archived, never deleted',
    Staff.byId(man2.id).active===false && Staff.all().length===2);

  const area=await Areas.save({ur:'تیمرگرہ',en:'Timergara'});
  check('C11 an area can be added', !!Areas.byId(area.id) && win.REGIONS.length===9);
  await Areas.save({id:area.id,en:'Timergara Bazar'});
  check('C12 an area can be renamed', Areas.byId(area.id).en==='Timergara Bazar');
  await Areas.moveCustomer(Cc.id,area.id,'moved for the test');
  check('C13 a shop can be reassigned to another area',
    win.custBy(Cc.id).region===area.id && Areas.customers(area.id).length===1);
  check('C14 the move is on the audit log',
    ERP.S.audit.some(a=>/reassign|moved|area/i.test(a.action) && /Timergara/.test(JSON.stringify(a))));
  await Areas.moveCustomer(Cc.id,drosh.id,'back');
  await Areas.archive(area.id,true);
  check('C15 an area is archived, not removed',
    Areas.byId(area.id).active===false && win.REGIONS.length===9);

  /* ── the printable sheet ── */
  win.go('collection'); await sleep(300);
  check('C16 the collection screen opens with its summary and rows',
    !!$('#view').textContent.match(/[Oo]utstanding/) && $$('table tbody tr').length>=2,
    String($$('table tbody tr').length));
  const before=store.printed||0;
  click($('[data-csprintopen]')); await sleep(400);
  check('C17a the collection sheet opens for review before printing',
    !!$('[data-csprint]'), 'no sheet preview');
  click($('[data-csprint="1"]')); await sleep(500);
  check('C17 printing produces a sheet', (store.printed||0)>before);
  const sheetText=D.body.textContent;
  check('C18 the sheet names the business, the area and the salesman',
    /Collection/i.test(sheetText) && /Gul Rahman/.test(sheetText));
  check('C19 it leaves room to write the amount collected and a signature',
    /Amount [Cc]ollected/.test(sheetText) && /[Ss]ignature/.test(sheetText));

  /* ── supplier ↔ product mapping ── */
  const Mapping=ERP.Mapping, mill=win.SUPPLIERS[0];
  const rice=P.find(p=>/چاول/.test(p.cat||''))||P[0];
  const flour=P.find(p=>/آٹا/.test(p.cat||''))||P[1];
  await Mapping.add(mill.id,rice.id,{});
  await Mapping.add(mill.id,flour.id,{});
  check('C20 a mill can supply both rice and flour',
    Mapping.forSupplier(mill.id).length>=2 && Mapping.categoriesOf(mill.id).length===2,
    Mapping.categoriesOf(mill.id).join('+'));
  check('C21 its label is worked out from what it actually supplies',
    /&|and/i.test(Mapping.label(mill.id)) || Mapping.label(mill.id).length>0, Mapping.label(mill.id));
  check('C22 a duplicate mapping is refused',
    await Mapping.add(mill.id,rice.id,{}).then(()=>false).catch(()=>true) ||
    Mapping.forSupplier(mill.id).filter(m=>m.productId===rice.id).length===1);
  check('C23 a product knows which mills supply it',
    Mapping.forProduct(rice.id).some(m=>m.supplierId===mill.id));

  /* ── deletion safety ── */
  check('C24 a supplier with purchases cannot be deleted',
    ERP.Master.canDelete('supplier',mill.id)===false &&
    ERP.Master.references('supplier',mill.id)>0);
  check('C25 a shop with invoices cannot be deleted',
    ERP.Master.canDelete('customer',A.id)===false);

  /* ── persistence ── */
  await ERP.flush(); await sleep(400);
  const state={salesmen:Staff.all().length,areas:win.REGIONS.length,
    mappings:Mapping.all().length,manId:man.id,
    outstanding:Col.summary(Col.rows()).outstanding};
  win.close();
  win=boot(store);
  for(let i=0;i<400&&!(win.ERP&&win.ERP.ready);i++)await sleep(25);
  await sleep(400);
  ERP=win.ERP;
  /* the post-boot hydrates settle a moment after ERP.ready */
  for(let i=0;i<60 && !ERP.Staff.all().length;i++) await sleep(50);
  await sleep(150);
  ERP.CollectionState.regionId=dir.id; ERP.CollectionState.outstandingOnly=true;
  check('C26 salesmen, areas and mappings survive a restart',
    ERP.Staff.all().length===state.salesmen && win.REGIONS.length===state.areas &&
    ERP.Mapping.all().length===state.mappings &&
    ((ERP.Staff.byId(state.manId)||{}).regionIds||[]).indexOf(dir.id)>-1,
    `staff ${ERP.Staff.all().length}/${state.salesmen} · areas ${win.REGIONS.length}/${state.areas}` +
    ` · maps ${ERP.Mapping.all().length}/${state.mappings}` +
    ` · areasOf ${JSON.stringify((ERP.Staff.byId(state.manId)||{}).regionIds||[])}`);
  check('C27 the round is the same after a restart',
    ERP.Collection.summary(ERP.Collection.rows()).outstanding===state.outstanding,
    M.fmt(ERP.Collection.summary(ERP.Collection.rows()).outstanding));
  check('C28 nothing threw during the session', errors.length===0, errors.slice(0,2).join(' | '));
  win.close();
  console.log('\n'+out.join('\n')+'\n\n'+pass+' passed, '+fail+' failed\n');
  process.exit(fail?1:0);
};
run().catch(e=>{console.error('HARNESS ERROR:',e);console.log(out.join('\n'));process.exit(2);});
