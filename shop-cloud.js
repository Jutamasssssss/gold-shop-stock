import {initializeApp, getApps} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import {getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserSessionPersistence} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import {getFirestore, collection, doc, onSnapshot, runTransaction, serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {stable, OWNER_UID} from './purchase-state.mjs';
import {mergeSavingsWrite, assertSavingsLedgerWrite, mergeSavingsCustomerWrite, sameLedgerWrite} from './savings-state.mjs?v=savings-20261020';

const app = getApps().find(app=>app.name==='purchase-shared') || initializeApp({apiKey:'AIzaSyBvSzkwvetsGtthnNljRZGMnlUC3pzfhXs',authDomain:'gold-shop-acf19.firebaseapp.com',projectId:'gold-shop-acf19',appId:'1:10469108848:web:c6bcefb2444ce4d55458b5'},'purchase-shared');
const auth=getAuth(app),db=getFirestore(app), observed=new Map(), subscriptions=new Set(), pending=new Map();
let session=0, writeQueue=Promise.resolve(), writesPending=0;
const clean=value=>{const result=JSON.parse(JSON.stringify(value));delete result._docId;return result;};
function check(){if(auth.currentUser?.uid!==OWNER_UID||!navigator.onLine)throw Error('ต้องเข้าสู่ระบบและเชื่อมต่ออินเทอร์เน็ตก่อนบันทึก');}
function status(text,error=false){window.shopCloudStatus?.(text,error);}
function deliver(key,callback,data,original){
 if(writesPending||window.shopHasPendingWork?.()){pending.set(key,()=>deliver(key,callback,data,original));return;}
 if(key==='savings'&&original.some(([id,value])=>(observed.get(id)?._savingsRevision||0)>(value?._savingsRevision||0))){pending.delete(key);return;}
 original.forEach(([key,value])=>observed.set(key,value));
 callback(data);pending.delete(key);
}
setInterval(()=>{if(!window.shopHasPendingWork?.())for(const fn of [...pending.values()])fn();},300);
async function saveMany(changes){
 check();
 const epoch=session;
 const rows=changes.map(({col,id,data})=>({col,id:String(id),data:clean(data),before:observed.has(col+'/'+id)?observed.get(col+'/'+id):(window.shopCollectionReady?.(col)?null:undefined)}));
 if(rows.length>150)throw Error('มีการเปลี่ยนแปลงเกิน 150 รายการ ระบบยังไม่บันทึก กรุณาแยกรายการ');
 for(const row of rows)if(row.before===undefined)throw Error('ยังไม่ได้อ่านข้อมูลล่าสุดของ '+row.col+' กรุณารอการเชื่อมต่อ');
 const run=async()=>{
  check();if(epoch!==session)throw Error('บัญชีเปลี่ยนระหว่างบันทึก');
  const committed=await runTransaction(db,async tx=>{
   const originals=[],resolved=[];
   for(const row of rows){const snap=await tx.get(doc(db,row.col,row.id));const actual=snap.exists()?snap.data():null;
    if(actual?._deleted&&!row.data._deleted)throw Error('รหัสรายการนี้มีข้อมูลเดิมที่ยกเลิกแล้ว กรุณาใช้รหัสใหม่เพื่อไม่ทับประวัติ');
    if(row.col==='savings')resolved.push({...row,data:mergeSavingsWrite(actual,row.before,row.data)});
    else if(row.col==='customers'&&rows.some(item=>item.col==='savings'))resolved.push({...row,data:mergeSavingsCustomerWrite(actual,row.before,row.data)});
    else {
     if(stable(actual)!==stable(row.before)&&stable(actual)!==stable(row.data)&&!(row.col==='savingsPayments'&&sameLedgerWrite(actual,row.data)))throw Error('ข้อมูล '+row.id+' ถูกแก้จากอีกเครื่องแล้ว ระบบไม่เขียนทับ กรุณาสำรองงานที่ยังไม่บันทึกแล้วเปิดหน้าใหม่');
     let data=row.data;
     if(row.col==='savingsPayments'){
      const account=resolved.find(item=>item.col==='savings'&&item.id===data.accountId)?.data;
      const payment=account?.payments?.find(item=>item.id===data.paymentId);
      if(payment&&!data._deleted)data={...data,payment};
      assertSavingsLedgerWrite(actual,data);
     }
     if(row.col==='transactions'&&data.type==='savings_close'){
      const account=resolved.find(item=>item.col==='savings'&&item.data.id===data.savingsId)?.data;
      if(account&&Number(data.total)!==Number(account.saved))throw Error('มีรายการออมใหม่ระหว่างปิดบัญชี กรุณาตรวจยอดล่าสุดก่อนรับสินค้า');
     }
     resolved.push({...row,data});
    }
    originals.push(actual);
   }
   resolved.forEach((row,index)=>{
    tx.set(doc(db,'shopAuditV1',crypto.randomUUID()),{collection:row.col,document:row.id,before:originals[index],after:row.data,by:OWNER_UID,at:serverTimestamp()});
    tx.set(doc(db,row.col,row.id),row.data);
   });
   return resolved.map(({col,id,data})=>({col,id,data}));
  });
  committed.forEach(row=>observed.set(row.col+'/'+row.id,row.data));
  return committed;
 };
 writesPending++;
 const result=writeQueue.then(run).catch(error=>{
  try{localStorage.setItem('gd_unsent_'+crypto.randomUUID(),JSON.stringify({at:new Date().toISOString(),changes:rows}));}catch{}
  status(error.message||'บันทึกข้อมูลไม่สำเร็จ',true);throw error;
 }).finally(()=>{writesPending--;});
 writeQueue=result.catch(()=>{});return result;
}
const api={
 saveMany,
 saveDoc:(col,id,data)=>{const key=col+'/'+id;if(!observed.has(key)&&window.shopCollectionReady?.(col))observed.set(key,null);return saveMany([{col,id,data}]);},
 deleteDoc:async(col,id)=>{check();const old=observed.get(col+'/'+id);if(!old)throw Error('ไม่พบข้อมูลล่าสุด');await saveMany([{col,id,data:{...old,_deleted:true,_deletedAt:new Date().toISOString()}}]);},
 listen:(col,callback)=>{
  const epoch=session;
  const stop=onSnapshot(collection(db,col),{includeMetadataChanges:true},snapshot=>{
   if(epoch!==session||snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)return;
   const originals=snapshot.docs.map(d=>[col+'/'+d.id,d.data()]);
   const items=snapshot.docs.map(d=>({...d.data(),_docId:d.id}));
   deliver(col,callback,items,originals);
  },()=>status('อ่านข้อมูล '+col+' ไม่สำเร็จ กรุณาตรวจสอบสิทธิ์หรืออินเทอร์เน็ต',true));subscriptions.add(stop);return stop;
 },
 listenDoc:(col,id,callback)=>{
  const epoch=session;
  const stop=onSnapshot(doc(db,col,id),{includeMetadataChanges:true},snapshot=>{
   if(epoch!==session||snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)return;
   const value=snapshot.exists()?snapshot.data():null;
   deliver(col+'/'+id,callback,value?{...value,_docId:id}:null,[[col+'/'+id,value]]);
  },()=>status('อ่านการตั้งค่าร้านไม่สำเร็จ',true));subscriptions.add(stop);return stop;
 },
 nextSequence:async(key,minimum=0)=>{
  check();return runTransaction(db,async tx=>{const ref=doc(db,'settings','counters'),snap=await tx.get(ref),next=Math.max(Number(snap.data()?.[key])||0,Number(minimum)||0)+1;tx.set(ref,{[key]:next,updatedAt:new Date().toISOString()},{merge:true});return next;});
 }
};
window.shopLogin=async(username,password)=>{await signInWithEmailAndPassword(auth,username.toLowerCase()==='admin'?'jutamas.blue@gmail.com':username,password);if(auth.currentUser?.uid!==OWNER_UID){await signOut(auth);throw Error('บัญชีนี้ไม่มีสิทธิ์เข้าร้าน');}};
window.shopLogout=()=>signOut(auth);
await setPersistence(auth,browserSessionPersistence);
onAuthStateChanged(auth,user=>{
 session++;subscriptions.forEach(stop=>stop());subscriptions.clear();observed.clear();pending.clear();
 window._fbReady=false;
 if(user?.uid===OWNER_UID){window._fb=api;window._fbReady=true;window.onShopAuth?.(user);}
 else window.onShopAuth?.(null);
});
window.addEventListener('offline',()=>status('ออฟไลน์ · ยังบันทึกไม่ได้ กรุณาเชื่อมต่อแล้วกดบันทึกอีกครั้ง'));
window.addEventListener('online',()=>status('เชื่อมต่อแล้ว · รายการที่ยังไม่ยืนยันให้ตรวจยอดและกดบันทึกอีกครั้ง'));
