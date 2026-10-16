export const COLLECTION = 'purchaseSharedV1';
export const HISTORY = 'purchaseHistoryV1';
export const OWNER_UID = 'CDblj4QbnzgNzrYoaZ8nOWDgWjU2';

export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function fail(message) { throw new Error(message); }
export function validateState(state) {
  if (!state || !Array.isArray(state.sales) || !Array.isArray(state.records)) fail('รูปแบบข้อมูลไม่ถูกต้อง');
  for (const key of ['sales', 'records']) {
    const ids = new Set(), refs = new Set();
    for (const row of state[key]) {
      if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(row.id)) fail('รหัสรายการไม่ถูกต้อง');
      if (ids.has(row.id)) fail('รหัสรายการซ้ำ');
      ids.add(row.id);
      if (typeof row.ref !== 'string' || !row.ref.trim()) fail('ไม่พบเลขที่เอกสาร');
      const ref = row.ref.trim().toLowerCase();
      if (refs.has(ref)) fail('เลขที่เอกสารซ้ำ: ' + row.ref);
      refs.add(ref);
      if (!Number.isSafeInteger(row.g) || row.g <= 0 || !Number.isSafeInteger(row.total) || row.total < 0) fail('น้ำหนักหรือยอดเงินไม่ถูกต้อง: ' + row.ref);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^\d{2}:\d{2}$/.test(row.time)) fail('วันที่หรือเวลาไม่ครบ: ' + row.ref);
      if (!['jewelry', 'bar'].includes(row.type)) fail('ประเภททองไม่ถูกต้อง: ' + row.ref);
      if (key === 'sales') {
        for (const line of row.lines || []) {
          if (line.laborCost != null && (!Number.isSafeInteger(line.laborCost) || line.laborCost < 0)) fail('ต้นทุนค่ากำเหน็จไม่ถูกต้อง: ' + row.ref);
        }
        const returned = new Set(), eventIds = new Set(), count = row.lines?.length || 1;
        if (row.returnHistory !== undefined && !Array.isArray(row.returnHistory)) fail('ประวัติคืนสินค้าไม่ถูกต้อง');
        for (const event of row.returnHistory || []) {
          if (!event.id || eventIds.has(event.id) || !['return', 'restore'].includes(event.action) || !/^\d{4}-\d{2}-\d{2}$/.test(event.date) || event.date < row.date || !/^\d{2}:\d{2}$/.test(event.time) || typeof event.reason !== 'string' || !event.reason.trim() || !Array.isArray(event.indexes) || !event.indexes.length || new Set(event.indexes).size !== event.indexes.length || !event.snapshot || !Number.isSafeInteger(event.snapshot.total) || !Array.isArray(event.snapshot.lines)) fail('ประวัติคืนสินค้าไม่ครบ: ' + row.ref);
          eventIds.add(event.id);
          for (const index of event.indexes) {
            if (!Number.isInteger(index) || index < 0 || index >= count || (event.action === 'return' ? returned.has(index) : !returned.has(index))) fail('รายการคืนสินค้าซ้ำหรือไม่ตรงกับต้นฉบับ');
            if (event.action === 'return') returned.add(index); else returned.delete(index);
          }
        }
      }
      if (key === 'records') {
        if (!Array.isArray(row.events)) fail('ประวัติรับทองไม่ครบ: ' + row.ref);
        const eventIds = new Set();
        for (const event of row.events) {
          if (!event.id || eventIds.has(event.id) || !Number.isSafeInteger(event.grams) || event.grams < 0 || !Number.isSafeInteger(event.money) || event.money < 0 || !event.date || !event.time) fail('ประวัติรับทองหรือชำระเงินไม่ถูกต้อง: ' + row.ref);
          eventIds.add(event.id);
        }
      }
    }
  }
  const sales = new Set(state.sales.map(row => row.id));
  if (state.records.some(row => row.saleId && !sales.has(row.saleId))) fail('ไม่พบงานขายที่เชื่อมกับใบล็อก');
  return state;
}

export function changesBetween(before, after) {
  validateState(after);
  const changes = [];
  for (const key of ['sales', 'records']) {
    const next = new Map(after[key].map(row => [row.id, row]));
    const old = new Map(before[key].map(row => [row.id, row]));
    for (const row of before[key]) {
      const replacement = next.get(row.id);
      if (!replacement) fail('ไม่อนุญาตให้ลบข้อมูลเดิม');
      if (key === 'sales' && (row.returnHistory?.length || replacement.returnHistory?.length)) {
        for (let i = 0; i < (row.returnHistory||[]).length; i++) {
          if (stable(row.returnHistory[i]) !== stable(replacement.returnHistory?.[i])) fail('ไม่อนุญาตให้ลบหรือเขียนทับประวัติคืนสินค้า');
        }
        const original = sale => ({ref:sale.ref,date:sale.date,time:sale.time,type:sale.type,item:sale.item,customer:sale.customer,g:sale.g,total:sale.total,qty:sale.qty,lines:(sale.lines||[]).map(({laborCost,...line})=>line)});
        if (stable(original(row)) !== stable(original(replacement))) fail('งานที่มีประวัติคืนสินค้าไม่สามารถเปลี่ยนรายการขายต้นฉบับ');
      }
      if (key === 'records') {
        for (let i = 0; i < row.events.length; i++) {
          if (stable(row.events[i]) !== stable(replacement.events[i])) fail('ไม่อนุญาตให้ลบหรือเขียนทับประวัติรับทองและชำระเงิน');
        }
      }
    }
    for (const row of after[key]) {
      const previous = old.get(row.id);
      if (stable(previous) !== stable(row)) changes.push({key, id: (key === 'sales' ? 'sale_' : 'lock_') + row.id, before: previous || null, after: row});
    }
  }
  if (changes.length > 150) fail('มีรายการเปลี่ยนมากเกินไป กรุณาแยกนำเข้าครั้งละไม่เกิน 150 รายการ');
  return changes;
}

export function mergeLegacy(cloud, legacy) {
  if (legacy.version !== 3) fail('รุ่นไฟล์สำรองไม่รองรับ');
  validateState(legacy);
  const result = {sales: [...cloud.sales], records: [...cloud.records]};
  for (const key of ['sales', 'records']) {
    for (const row of legacy[key]) {
      const sameId = cloud[key].find(x => x.id === row.id);
      if (sameId) {
        if (stable(sameId) !== stable(row)) fail('ข้อมูลในเครื่องกับฐานข้อมูลต่างกัน: ' + row.ref + ' ระบบไม่เขียนทับ กรุณาตรวจสอบไฟล์สำรอง');
      } else {
        if (cloud[key].some(x => x.ref.trim().toLowerCase() === row.ref.trim().toLowerCase())) fail('เลขที่เอกสารซ้ำคนละรายการ: ' + row.ref + ' ระบบยังไม่นำเข้าหรือเปลี่ยนเลขที่');
        result[key].push(row);
      }
    }
  }
  validateState(result);
  return result;
}

// A single revision protects a multi-document snapshot from concurrent edits.
export async function commitState(store, base, next, uid, operationId) {
  const changes = changesBetween(base, next);
  if (!changes.length) return {...next, revision: base.revision};
  const signature = stable(changes);
  if (new TextEncoder().encode(JSON.stringify({changes, signature})).length > 750000) fail('ข้อมูลครั้งนี้ใหญ่เกินขนาดประวัติสำรอง ระบบยังไม่บันทึกหรือเปลี่ยนข้อมูล กรุณาแบ่งรายการนำเข้า');
  const revision = base.revision + 1;
  await store.transaction(async tx => {
    const meta = await tx.get(COLLECTION, '_meta');
    const completed = await tx.get(HISTORY, operationId);
    if (completed) {
      if (completed.signature !== signature) fail('รหัสการบันทึกซ้ำ');
      return;
    }
    if ((meta?.revision || 0) !== base.revision) fail('มีข้อมูลใหม่จากอีกเครื่อง กรุณาปิดงานแล้วเปิดใหม่ก่อนบันทึก ข้อมูลที่กรอกยังอยู่ในฟอร์ม');
    for (const change of changes) tx.set(COLLECTION, change.id, {kind: change.key, data: change.after, revision, updatedBy: uid});
    tx.set(COLLECTION, '_meta', {revision, updatedBy: uid});
    tx.set(HISTORY, operationId, {revision, user: uid, at: store.timestamp(), signature, changes});
  });
  return {...next, revision};
}
