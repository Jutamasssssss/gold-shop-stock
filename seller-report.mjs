const sellerName = value => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Allocate integer satang once per job so seller totals reconcile exactly.
export function allocateCost(total, weights) {
  if (!integer(total) || !weights.length || weights.some(n => !integer(n) || n === 0)) return weights.map(() => null);
  const denominator = weights.reduce((sum, n) => sum + BigInt(n), 0n);
  const parts = weights.map((n, index) => {
    const value = BigInt(total) * BigInt(n);
    return {index, amount: Number(value / denominator), remainder: value % denominator};
  });
  let remaining = total - parts.reduce((sum, part) => sum + part.amount, 0);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of ranked) { if (!remaining) break; part.amount++; remaining--; }
  return parts.map(part => part.amount);
}

function emptyTotals() {
  return {qty:0, sales:0, weight:0, profit:0, cost:0, knownQty:0, pendingQty:0, pendingSales:0, returnedQty:0, returnedSales:0, jobs:new Set()};
}

function addLine(totals, line, basis) {
  if (line.returned) { totals.returnedQty += line.qty; totals.returnedSales += line.sales; return; }
  totals.jobs.add(line.saleId);
  totals.qty += line.qty; totals.sales += line.sales; totals.weight += line.weight;
  const profit = basis === 'receipt' ? line.actualProfit : line.lockProfit;
  if (profit === null) { totals.pendingQty += line.qty; totals.pendingSales += line.sales; }
  else { totals.knownQty += line.qty; totals.profit += profit; totals.cost += line.sales - profit; }
}

function finalized(totals) { return {...totals, jobs:totals.jobs.size}; }

export function buildSellerReport(profitRows, {month='', seller='', basis='lock'} = {}) {
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('เดือนรายงานไม่ถูกต้อง');
  if (!['lock', 'receipt'].includes(basis)) throw new Error('ประเภทต้นทุนไม่ถูกต้อง');
  const lines = [], issues = [];
  for (const row of profitRows) {
    const sale = row.originalSale || row.sale;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(sale.date || '') ? new Date(sale.date+'T12:00:00Z') : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== sale.date) { issues.push({ref:sale.ref, reason:'วันที่ขายไม่ถูกต้อง'}); continue; }
    if (month && sale.date.slice(0, 7) !== month) continue;
    const original = sale.lines?.length ? sale.lines : [{seller:sale.seller || '', customer:sale.customer, g:sale.g, price:sale.total, qty:sale.qty, laborCost:sale.legacyLaborCost ?? null}];
    if (original.some(line => !integer(line.price) || !integer(line.g) || line.g === 0 || !Number.isSafeInteger(line.qty ?? 1) || (line.qty ?? 1) < 1)
      || original.reduce((sum, line) => sum + line.price, 0) !== sale.total
      || original.reduce((sum, line) => sum + line.g, 0) !== sale.g
      || original.reduce((sum, line) => sum + (line.qty ?? 1), 0) !== sale.qty) {
      issues.push({ref:sale.ref, reason:'ยอดหรือจำนวนชิ้นไม่ตรงกับรายการย่อย'}); continue;
    }
    const returned = new Set();
    for (const event of sale.returnHistory || []) for (const index of event.indexes) event.action === 'return' ? returned.add(index) : returned.delete(index);
    const active = original.map((line, index) => ({line, index})).filter(({index}) => !returned.has(index));
    const lockReady = Number.isSafeInteger(row.expected) && integer(row.allocatedLockCost);
    const receiptReady = Number.isSafeInteger(row.actual) && integer(row.actualCost) && integer(row.laborCost);
    const locked = allocateCost(lockReady ? row.allocatedLockCost : null, active.map(({line}) => line.g));
    const received = allocateCost(receiptReady ? row.actualCost - row.laborCost : null, active.map(({line}) => line.g));
    const position = new Map(active.map(({index}, i) => [index, i]));
    original.forEach((line, index) => {
      const name = sellerName(line.seller), key = name ? 'seller:' + name.toLocaleLowerCase('th-TH') : 'unassigned';
      const i = position.get(index), labor = integer(line.laborCost) ? line.laborCost : null, isReturn = returned.has(index);
      const lockCost = !isReturn && labor !== null && locked[i] !== null && locked[i] !== undefined ? locked[i] + labor : null;
      const receiptCost = !isReturn && labor !== null && received[i] !== null && received[i] !== undefined ? received[i] + labor : null;
      lines.push({key, seller:name || 'ไม่ระบุผู้ขาย', saleId:sale.id, ref:sale.ref, date:sale.date, time:sale.time || '', index,
        customer:line.customer || sale.customer || '', channel:line.channel || '', orderNumber:line.orderNumber || '', item:sale.item || '',
        qty:line.qty ?? 1, weight:line.g, sales:line.price, laborCost:labor, lockCost, receiptCost,
        lockProfit:lockCost === null ? null : line.price - lockCost, actualProfit:receiptCost === null ? null : line.price - receiptCost, returned:isReturn});
    });
  }
  const choices = new Map();
  for (const line of lines) if (!choices.has(line.key)) choices.set(line.key, line.seller);
  const selected = lines.filter(line => !seller || line.key === seller).sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time) || a.ref.localeCompare(b.ref) || a.index-b.index);
  const groups = new Map(), totals = emptyTotals();
  for (const line of selected) {
    if (!groups.has(line.key)) groups.set(line.key, {...emptyTotals(), key:line.key, seller:line.seller});
    addLine(groups.get(line.key), line, basis); addLine(totals, line, basis);
  }
  return {month, seller, basis, lines:selected, issues,
    choices:[...choices].map(([key, name]) => ({key, name})).sort((a,b) => a.name.localeCompare(b.name, 'th')),
    groups:[...groups.values()].map(finalized).sort((a,b) => b.sales-a.sales || a.seller.localeCompare(b.seller, 'th')),
    totals:finalized(totals)};
}

const csvCell = value => {
  const text=String(value ?? '');
  const safe=/^-?\d+(\.\d+)?$/.test(text)?text:text.replace(/^\s*[=+@-]/, "'$&");
  return '"'+safe.replaceAll('"','""')+'"';
};
const amount = value => value === null ? 'รอต้นทุนครบ' : (value / 100).toFixed(2);
export function sellerReportCsv(report, detail=false) {
  if (report.issues.length) throw new Error('ยังส่งออกไม่ได้ มี '+report.issues.length+' งานที่ต้องตรวจข้อมูลก่อน');
  const basis = report.basis === 'receipt' ? 'ใบรับทองจริง' : 'ใบล็อกทอง';
  const rows = detail
    ? [['เดือนขาย','ต้นทุนอ้างอิง','พนักงานขาย','เลขที่งาน','วันที่ขาย','ชิ้นที่','ลูกค้า','ช่องทาง','เลขคำสั่งซื้อ','จำนวนชิ้น','น้ำหนักกรัม','ยอดขายบาท','ต้นทุนค่ากำเหน็จบาท','ต้นทุนขายบาท','กำไรบาท','สถานะ'],
      ...report.lines.map(line => [report.month || 'ทุกเดือน',basis,line.seller,line.ref,line.date,line.index+1,line.customer,line.channel,line.orderNumber,line.qty,(line.weight/10000).toFixed(4),amount(line.sales),amount(line.laborCost),line.returned?'ไม่นับรวม':amount(report.basis==='receipt'?line.receiptCost:line.lockCost),line.returned?'ไม่นับรวม':amount(report.basis==='receipt'?line.actualProfit:line.lockProfit),line.returned?'คืนสินค้า':'ขายสุทธิ'])]
    : [['เดือนขาย','ต้นทุนอ้างอิง','พนักงานขาย','จำนวนงาน','ชิ้นขายสุทธิ','ยอดขายสุทธิบาท','ต้นทุนเฉพาะชิ้นที่พร้อมบาท','กำไรเฉพาะชิ้นที่พร้อมบาท','ชิ้นที่คำนวณกำไรแล้ว','ชิ้นรอต้นทุน','ยอดขายรอต้นทุนบาท','ชิ้นคืน','ยอดคืนบาท'],
      ...report.groups.map(group => [report.month || 'ทุกเดือน',basis,group.seller,group.jobs,group.qty,amount(group.sales),group.knownQty?amount(group.cost):'รอต้นทุนครบ',group.knownQty?amount(group.profit):'รอต้นทุนครบ',group.knownQty,group.pendingQty,amount(group.pendingSales),group.returnedQty,amount(group.returnedSales)])];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
