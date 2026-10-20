import {stable} from './purchase-state.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const cents = value => Math.round(Number(value) * 100);
const same = (a, b) => stable(a ?? null) === stable(b ?? null);
const withoutClock = value => {
  const result = {...value};
  delete result._updatedAt;
  delete result.updatedAt;
  delete result._savingsPaymentRevision;
  delete result._savingsRevision;
  return result;
};
function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
}
export function normalizeAccount(raw) {
  const account = clone(raw || {});
  const accountId = String(account.id || account.accountNo || account._docId || 'savings');
  const occurrences = new Map();
  account.payments = (account.payments || []).map(payment => {
    const fingerprint = [payment.date || '', Number(payment.deposit || 0), Number(payment.bonus || 0), Number(payment.total || 0), Number(payment.goldPrice || 0), Number(payment.goldWeight || 0)].join('|');
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    return {...payment, id:payment.id || `svp_legacy_${hash(`${accountId}|${fingerprint}|${occurrence}`)}`};
  });
  account._deletedPayments = account._deletedPayments || [];
  return account;
}
export function paymentTotal(payment) {
  return payment.total == null ? Number(payment.deposit || 0) + Number(payment.bonus || 0) : Number(payment.total);
}
function checkedPayment(payment) {
  if (!payment.id || !payment.date || !Number.isFinite(Date.parse(payment.date))) throw Error('กรุณาระบุวันที่ออมให้ถูกต้อง');
  if (![payment.deposit, payment.bonus, paymentTotal(payment), payment.goldPrice, payment.goldWeight].every(n => Number.isFinite(Number(n)) && Number(n) >= 0) || Number(payment.deposit) <= 0) throw Error('ยอดออมและราคาทองต้องเป็นตัวเลขที่ถูกต้อง');
  if (cents(paymentTotal(payment)) !== cents(Number(payment.deposit) + Number(payment.bonus))) throw Error('ยอดออมรวมไม่ตรงกับยอดฝากและโบนัส');
}
function paymentMap(account) {
  const map = new Map();
  for (const payment of account.payments) {
    if (map.has(payment.id)) throw Error('พบรหัสงวดออมซ้ำ กรุณาตรวจประวัติก่อนบันทึก');
    map.set(payment.id, payment);
  }
  return map;
}
export function mergeSavingsWrite(actualRaw, beforeRaw, proposedRaw) {
  if (proposedRaw._deleted) {
    if (!same(actualRaw, beforeRaw) && !same(actualRaw, proposedRaw)) throw Error('บัญชีออมถูกแก้จากอีกเครื่องแล้ว กรุณาตรวจสอบก่อนยกเลิก');
    return proposedRaw;
  }
  if (actualRaw?._deleted) throw Error('บัญชีออมนี้ถูกยกเลิกแล้ว ระบบไม่เขียนทับประวัติ');
  if (beforeRaw && !actualRaw) throw Error('ไม่พบต้นฉบับบัญชีออม ระบบหยุดบันทึกเพื่อรักษาข้อมูล');
  if (!beforeRaw && actualRaw && !same(withoutClock(normalizeAccount(actualRaw)), withoutClock(normalizeAccount(proposedRaw)))) throw Error('เลขบัญชีออมนี้ถูกใช้แล้ว กรุณาตรวจบัญชีที่มีอยู่ก่อนเปิดบัญชีใหม่');
  const actual = normalizeAccount(actualRaw), before = normalizeAccount(beforeRaw), proposed = normalizeAccount(proposedRaw);
  const currentPayments = paymentMap(actual), oldPayments = paymentMap(before), wantedPayments = paymentMap(proposed);
  const tombstones = new Map(actual._deletedPayments.map(item => [String(item.id), item]));
  const oldTombstones = new Set(before._deletedPayments.map(item => String(item.id)));
  for (const item of proposed._deletedPayments) {
    if (!oldTombstones.has(String(item.id))) {
      if (!same(withoutClock(currentPayments.get(item.id)), withoutClock(oldPayments.get(item.id)))) throw Error('งวดที่เลือกถูกแก้จากอีกเครื่องแล้ว กรุณาตรวจสอบก่อนยกเลิก');
      tombstones.set(String(item.id), item);
    }
  }
  for (const [id, old] of oldPayments) {
    if (!wantedPayments.has(id) && !tombstones.has(id)) throw Error('รายการออมเดิมไม่ครบ ระบบไม่อนุญาตให้เขียนทับจนยอดหาย');
    if (!currentPayments.has(id) && !tombstones.has(id)) throw Error('รายการออมบนฐานข้อมูลไม่ครบ กรุณาตรวจประวัติก่อนบันทึก');
  }
  for (const [id, wanted] of wantedPayments) {
    const old = oldPayments.get(id), current = currentPayments.get(id);
    if (same(withoutClock(wanted), withoutClock(old))) continue;
    if (tombstones.has(id)) throw Error('งวดนี้ถูกยกเลิกแล้ว ระบบไม่สร้างคืนเอง');
    if (!old && actual.status === 'closed') throw Error('บัญชีออมปิดรับสินค้าแล้ว กรุณาตรวจสอบก่อนเพิ่มยอด');
    if (current && !same(withoutClock(current), withoutClock(old)) && !same(withoutClock(current), withoutClock(wanted))) throw Error('งวดออมเดียวกันถูกแก้จากอีกเครื่องแล้ว ระบบเก็บต้นฉบับไว้ กรุณาเปิดงวดตรวจสอบอีกครั้ง');
    checkedPayment(wanted);
    if (!same(withoutClock(current),withoutClock(wanted))) currentPayments.set(id, {...wanted,_savingsPaymentRevision:(Number(current?._savingsPaymentRevision)||0)+1});
  }
  tombstones.forEach((_item, id) => currentPayments.delete(id));
  const next = {...actual};
  const special = new Set(['payments','saved','_deletedPayments','_updatedAt','updatedAt','_docId','_savingsRevision']);
  for (const key of Object.keys(proposed)) {
    if (special.has(key) || same(proposed[key], before[key])) continue;
    if (!same(actual[key], before[key]) && !same(actual[key], proposed[key])) throw Error('ข้อมูลบัญชีออมถูกแก้จากอีกเครื่องแล้ว กรุณาตรวจสอบก่อนบันทึก');
    next[key] = proposed[key];
  }
  // A saved balance without matching rows is evidence to investigate, never an opening balance to invent.
  if (actualRaw?.saved != null && cents(actualRaw.saved) > actual.payments.reduce((n, p) => n + cents(paymentTotal(p)), 0)) throw Error('ยอดสะสมเดิมมากกว่ารายการงวดที่พบ ระบบหยุดบันทึกเพื่อไม่ลดข้อมูลเดิม กรุณาตรวจรายการสำรอง');
  next.payments = [...currentPayments.values()];
  next._deletedPayments = [...tombstones.values()];
  next.saved = next.payments.reduce((n, p) => n + cents(paymentTotal(p)), 0) / 100;
  next._updatedAt = proposed._updatedAt || new Date().toISOString();
  next._savingsRevision = (Number(actual._savingsRevision) || 0) + 1;
  return next;
}

export function assertSavingsLedgerWrite(actual, proposed) {
  if (actual?._deleted && !proposed._deleted) throw Error('งวดออมนี้ถูกยกเลิกแล้ว ระบบไม่เขียนทับประวัติ');
  if (!proposed._deleted) checkedPayment(proposed.payment || {});
}
export function sameLedgerWrite(a, b) {
  if (!a || !b) return same(a,b);
  return same({...withoutClock(a),payment:withoutClock(a.payment)},{...withoutClock(b),payment:withoutClock(b.payment)});
}

export function mergeSavingsCustomerWrite(actual, before, proposed) {
  if (actual?._deleted) throw Error('ข้อมูลลูกค้านี้ถูกยกเลิกแล้ว กรุณาตรวจสอบก่อนบันทึก');
  const next = {...(actual || proposed),transactions:[...(actual?.transactions || [])]};
  for (const event of proposed.transactions || []) {
    if ((before?.transactions || []).some(old => same(old,event))) continue;
    if (!event.id) throw Error('รายการประวัติลูกค้าไม่มีรหัสอ้างอิง');
    const existing = next.transactions.find(old=>old.id===event.id);
    if (existing && !same(existing,event)) throw Error('รายการลูกค้ารหัสเดียวกันมียอดต่างกัน กรุณาตรวจสอบก่อนบันทึก');
    if (!existing) next.transactions.push(event);
  }
  return next;
}
