/* Durable recovery is separate from the small localStorage display cache. */
(() => {
  let opening;
  function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('gold-shop-recovery-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', {keyPath:'key'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Recovery storage is blocked'));
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      const request = action(tx.objectStore('records'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error('Recovery storage write aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
  function local(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  async function read(key) {
    const old = local(key);
    // A failed read must not silently resurrect an older localStorage draft.
    const record = await transaction('readonly', store => store.get(key));
    return record && (!old || (record.value?._recoveryStoredAt || 0) >= (old._recoveryStoredAt || 0)) ? record.value : old;
  }
  async function write(key, value) {
    const stored = {...value, _recoveryStoredAt:Date.now()};
    try {
      await transaction('readwrite', store => store.put({key, value:stored}));
    } catch (error) {
      try { localStorage.setItem(key, JSON.stringify(stored)); return; }
      catch { throw Error('พื้นที่เก็บรายการรอบันทึกไม่พร้อม ยังไม่ส่งยอด กรุณาดาวน์โหลดสำรองและตรวจพื้นที่เครื่อง โดยไม่ล้างข้อมูลเว็บ'); }
    }
  }
  async function checkpoint(raw) {
    if (!raw || raw === '[]') return;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), byte => byte.toString(16).padStart(2,'0')).join('');
    const key = 'gd_savings_checkpoint_' + hash;
    if (!await read(key)) await write(key, {at:new Date().toISOString(), data:raw});
  }
  async function entries() {
    return await transaction('readonly', store => store.getAll());
  }
  window.savingsRecovery = {read, write, checkpoint, entries};
})();
