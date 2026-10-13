import {COLLECTION, HISTORY, OWNER_UID, validateState, mergeLegacy, commitState} from './purchase-state.mjs';

const ui = id => document.getElementById(id);
const empty = () => ({sales: [], records: [], revision: 0});
let db, auth, api, authApi, unsubscribe, base = empty(), ready = false, busy = false;
let deferred = null, pendingOperation = null, sessionEpoch = 0;
const localKey = 'gold-shop-purchase-pilot-v1';
const message = text => { ui('cloudStatus').textContent = text; };
const editing = () => !!document.querySelector('dialog[open]');
const identity = () => auth?.currentUser?.uid === OWNER_UID;
function setGate(text) {
  ui('authGate').hidden = false;
  ui('purchaseApp').hidden = true;
  ui('authError').textContent = text || '';
}
function emitState(state) {
  base = structuredClone(state);
  window.dispatchEvent(new CustomEvent('purchase-cloud-state', {detail: structuredClone(state)}));
}
function useSnapshot(state) {
  if (state.revision < base.revision) return;
  if (busy || editing()) {
    if (state.revision > base.revision) {
      deferred = state;
      ready = false;
      message('มีข้อมูลใหม่จากอีกเครื่อง กรุณาปิดงานแล้วเปิดใหม่ก่อนแก้ไข');
    } else if (!busy && !deferred) {
      ready = true;
      message('เชื่อมฐานข้อมูลร่วมแล้ว · รุ่นข้อมูล ' + base.revision);
    }
    return;
  }
  deferred = null;
  emitState(state);
  ready = true;
  message('เชื่อมฐานข้อมูลร่วมแล้ว · รุ่นข้อมูล ' + base.revision);
}
function acceptSnapshot(snapshot, epoch) {
  if (epoch !== sessionEpoch || !identity()) return;
  if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) { ready = false; message('รอการยืนยันข้อมูลล่าสุดจากฐานข้อมูล…'); return; }
  try {
    const state = empty();
    snapshot.forEach(document => {
      const value = document.data();
      if (document.id === '_meta') state.revision = value.revision;
      else if (value.kind === 'sales' || value.kind === 'records') state[value.kind].push(value.data);
      else throw new Error('พบข้อมูลที่ไม่รองรับ ระบบระงับการเขียนทับ');
    });
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || (!state.revision && (state.sales.length || state.records.length))) throw new Error('รุ่นข้อมูลไม่สมบูรณ์');
    validateState(state); useSnapshot(state);
  } catch (error) { ready = false; message('อ่านข้อมูลไม่สำเร็จ: ' + error.message); }
}
function restoreAfterClose() {
  if (busy || editing() || !identity()) return;
  if (deferred) useSnapshot(deferred);
}
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', restoreAfterClose));
function download(value, name) {
  const url = URL.createObjectURL(new Blob([value], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showLegacyCount() {
  try {
    const raw = localStorage.getItem(localKey);
    const local = raw ? JSON.parse(raw) : null;
    ui('legacyNotice').hidden = !local;
    ui('legacyCount').textContent = local ? 'ข้อมูลเดิมในเครื่องนี้: ' + (local.sales?.length || 0) + ' งานขาย / ' + (local.records?.length || 0) + ' ใบล็อก ยังเก็บไว้ครบในเครื่อง' : '';
  } catch {
    ui('legacyNotice').hidden = false;
    ui('legacyCount').textContent = 'ข้อมูลเดิมในเครื่องอ่านไม่สำเร็จ โปรดดาวน์โหลดสำรอง ระบบจะไม่เขียนทับ';
  }
}
window.purchaseCloud = {
  async save(next) {
    if (!identity() || !ready || busy || deferred || !navigator.onLine) throw new Error('ยังบันทึกไม่ได้ กรุณาตรวจสอบการเชื่อมต่อ หรือปิดงานแล้วเปิดใหม่เพื่อรับข้อมูลล่าสุด');
    busy = true;
    const epoch = sessionEpoch, previousBase = structuredClone(base);
    const key = JSON.stringify(next);
    if (!pendingOperation || pendingOperation.key !== key) pendingOperation = {key, id: crypto.randomUUID()};
    const operationId = pendingOperation.id;
    message('กำลังบันทึกลงฐานข้อมูลร่วม…');
    try {
      const saved = await commitState({
        timestamp: () => api.serverTimestamp(),
        transaction: callback => api.runTransaction(db, tx => callback({
          get: async (collection, id) => { const value = await tx.get(api.doc(db, collection, id)); return value.exists() ? value.data() : null; },
          set: (collection, id, value) => tx.set(api.doc(db, collection, id), value)
        }))
      }, previousBase, next, auth.currentUser.uid, operationId);
      if (epoch !== sessionEpoch) throw new Error('บัญชีเปลี่ยนระหว่างบันทึก กรุณาเข้าสู่ระบบใหม่เพื่อตรวจสอบรายการ');
      emitState(saved);
      pendingOperation = null;
      if (deferred?.revision <= saved.revision) deferred = null;
      ready = !deferred;
      message(deferred ? 'บันทึกสำเร็จ แต่มีข้อมูลใหม่จากอีกเครื่อง กรุณาปิดงานเพื่ออัปเดต' : 'บันทึกลงฐานข้อมูลร่วมแล้ว · รุ่นข้อมูล ' + saved.revision);
      return saved;
    } catch (error) {
      message('ยังไม่ยืนยันการบันทึก · ' + error.message);
      throw error;
    } finally { busy = false; }
  }
};

ui('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  ui('authError').textContent = '';
  if (!auth) { ui('authError').textContent = 'ระบบล็อกอินยังโหลดไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วเปิดหน้าใหม่'; return; }
  const username = ui('authUsername').value.trim();
  const email = username.toLowerCase() === 'admin' ? 'jutamas.blue@gmail.com' : username;
  ui('authSubmit').disabled = true;
  try { await authApi.signInWithEmailAndPassword(auth, email, ui('authPassword').value); ui('authPassword').value = ''; }
  catch { ui('authError').textContent = 'เข้าสู่ระบบไม่สำเร็จ ตรวจสอบชื่อผู้ใช้และรหัสผ่าน หรือรอสักครู่แล้วลองใหม่'; }
  finally { ui('authSubmit').disabled = false; }
});
ui('cloudLogout').addEventListener('click', async () => {
  if (busy) { message('กรุณารอการบันทึกให้เสร็จก่อนออกจากระบบ'); return; }
  if (editing() && !confirm('มีฟอร์มเปิดอยู่ ข้อมูลที่ยังไม่กดบันทึกจะไม่ถูกเก็บ ต้องการออกจากระบบหรือไม่?')) return;
  await authApi.signOut(auth);
});
ui('downloadLegacy').addEventListener('click', () => {
  try { download(localStorage.getItem(localKey) || '{}', 'gold-purchase-original-' + Date.now() + '.json'); }
  catch { message('ดาวน์โหลดสำรองไม่ได้ กรุณาตรวจสอบพื้นที่จัดเก็บ'); }
});
ui('downloadCloud').addEventListener('click', () => {
  if (!identity() || !ready) { message('รอข้อมูลจากฐานข้อมูลร่วมให้ครบก่อนดาวน์โหลด'); return; }
  download(JSON.stringify({version: 3, ...base}, null, 2), 'gold-purchase-shared-' + Date.now() + '.json');
});
async function importRaw(raw) {
  if (editing() || !ready || busy) throw new Error('กรุณาปิดงานและรอข้อมูลล่าสุดก่อนนำเข้า');
  const merged = mergeLegacy(base, JSON.parse(raw));
  const count = merged.sales.length + merged.records.length - base.sales.length - base.records.length;
  if (!count) { message('ทุกรายการมีอยู่ในฐานข้อมูลแล้ว ไม่ได้เพิ่มซ้ำ'); return; }
  if (!confirm('นำเข้า ' + count + ' รายการสู่ฐานข้อมูลร่วมของร้าน ทุกคนที่มีสิทธิ์จะเห็นข้อมูลนี้ โดยไม่ลบข้อมูลเดิม ยืนยันหรือไม่?')) return;
  download(raw, 'gold-purchase-before-import-' + Date.now() + '.json');
  await window.purchaseCloud.save(merged);
  message('นำเข้า ' + count + ' รายการแล้ว · ข้อมูลต้นฉบับในเครื่องยังอยู่ครบ');
}
ui('importLegacy').addEventListener('click', async () => {
  try { const raw = localStorage.getItem(localKey); if (!raw) throw new Error('ไม่พบข้อมูลเดิมในเครื่องนี้'); await importRaw(raw); }
  catch (error) { message(error.message); }
});
ui('importBackup').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 10 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 10 MB'); await importRaw(await file.text()); }
  catch (error) { message(error.message); }
  finally { event.target.value = ''; }
});
window.addEventListener('offline', () => { ready = false; message('ออฟไลน์ · ยังบันทึกไม่ได้ ข้อมูลที่กรอกยังอยู่ในฟอร์ม'); });
window.addEventListener('online', async () => {
  if (!identity()) return;
  const epoch = sessionEpoch;
  message('กำลังเชื่อมต่อฐานข้อมูลอีกครั้ง…');
  try { acceptSnapshot(await api.getDocsFromServer(api.collection(db, COLLECTION)), epoch); }
  catch { if (epoch === sessionEpoch) { ready = false; message('ยังเชื่อมฐานข้อมูลไม่ได้ ข้อมูลที่กรอกยังอยู่ในฟอร์ม'); } }
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

try {
  const appApi = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js');
  authApi = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
  api = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js');
  const app = appApi.initializeApp({apiKey:'AIzaSyBvSzkwvetsGtthnNljRZGMnlUC3pzfhXs',authDomain:'gold-shop-acf19.firebaseapp.com',projectId:'gold-shop-acf19',appId:'1:10469108848:web:c6bcefb2444ce4d55458b5'}, 'purchase-shared');
  auth = authApi.getAuth(app); db = api.getFirestore(app);
  await authApi.setPersistence(auth, authApi.browserSessionPersistence);
  authApi.onAuthStateChanged(auth, user => {
    sessionEpoch++; unsubscribe?.(); ready = false; busy = false; deferred = null; pendingOperation = null;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    emitState(empty());
    if (!user) { setGate(); return; }
    if (user.uid !== OWNER_UID) { setGate('บัญชีนี้ยังไม่มีสิทธิ์เข้าข้อมูลร้าน'); return; }
    ui('authGate').hidden = true; ui('purchaseApp').hidden = false; showLegacyCount();
    message('กำลังโหลดข้อมูลร่วมจากฐานข้อมูล…');
    const epoch = sessionEpoch;
    unsubscribe = api.onSnapshot(api.collection(db, COLLECTION), {includeMetadataChanges: true}, snapshot => acceptSnapshot(snapshot, epoch), () => { ready = false; message('เข้าถึงฐานข้อมูลไม่ได้ กรุณาตรวจสอบสิทธิ์และการเชื่อมต่อ ข้อมูลเดิมไม่ถูกเปลี่ยน'); });
  });
} catch {
  setGate('โหลดระบบล็อกอินไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วเปิดหน้าใหม่ ข้อมูลเดิมยังอยู่');
}
