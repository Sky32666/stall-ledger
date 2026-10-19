// node --test stall-ledger/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseReport, amountsIn, findDate } = require('../ocr.js');

test('typical Z report', () => {
  const text = `
    UNCLE LIM WESTERN FOOD
    Z REPORT        #0123
    Date: 18/10/2026  22:41
    -----------------------------
    Gross Sales          1,312.50
    Discount               -12.50
    Net Sales            1,300.00
    GST 9% (incl)          107.34
    No. of Trans               87
    -----------------------------
    CASH                   520.00
    NETS                   410.00
    VISA                    90.00
    PAYNOW                 200.00
    GRABFOOD                80.00
    Rounding                 0.00
  `;
  const r = parseReport(text);
  assert.equal(r.total, 130000);
  assert.deepEqual(r.pay, { cash: 52000, card: 50000, paynow: 20000, delivery: 8000 });
  assert.equal(r.orders, 87);
  assert.equal(r.date, '2026-10-18');
});

test('bare TOTAL and payment summary lines', () => {
  const r = parseReport(`
    DAILY SALES SUMMARY  2026-10-19
    TOTAL            $ 845.20
    CASH TOTAL       $ 300.20
    CARD TOTAL       $ 245.00
    QR               $ 300.00
    CHANGE           $  12.00
  `);
  assert.equal(r.total, 84520);
  assert.deepEqual(r.pay, { cash: 30020, card: 24500, paynow: 30000 });
  assert.equal(r.date, '2026-10-19');
});

test('net sales wins over a later bare total', () => {
  const r = parseReport('NET SALES 600.00\nTOTAL 654.00\nCASH 600.00');
  assert.equal(r.total, 60000);
});

test('no total line: payments add up', () => {
  const r = parseReport('CASH 100.00\nNETS 50.50');
  assert.equal(r.total, 15050);
});

test('OCR noise in amounts', () => {
  assert.deepEqual(amountsIn('NETS 1O5.00'), [10500]);
  assert.deepEqual(amountsIn('CASH S$1 234.50'), [123450]);
  assert.deepEqual(amountsIn('PAYNOW 85,00'), [8500]);
  assert.deepEqual(amountsIn('DISCOUNT -12.50'), [-1250]);
});

test('zeros read inside words still match keywords', () => {
  const r = parseReport('NET SALES 100.00\nGRABF00D 80.00\nCASH 20.00');
  assert.deepEqual(r.pay, { delivery: 8000, cash: 2000 });
});

test('ignored lines do not count as payments', () => {
  const r = parseReport('TOTAL 100.00\nCASH 100.00\nCASH OUT 20.00\nOPENING FLOAT 50.00');
  assert.deepEqual(r.pay, { cash: 10000 });
});

test('dates', () => {
  assert.equal(findDate(['18-10-26']), '2026-10-18');
  assert.equal(findDate(['18 OCT 2026']), '2026-10-18');
  assert.equal(findDate(['nothing here']), null);
});

test('item sales lines', () => {
  const r = parseReport(`
    Z REPORT  18/10/2026
    ITEM SALES
    CHICKEN CHOP          23     207.00
    2 X FISH & CHIPS              19.80
    AGLIO OLIO X5 @8.50           42.50
    Chicken Chop           1       9.00
    ITEMS SOLD            31     278.30
    NET SALES                    278.30
    CASH                         278.30
  `);
  assert.deepEqual(r.items, [
    { name: 'Chicken Chop', qty: 24, amount: 21600 },
    { name: 'Fish & Chips', qty: 2, amount: 1980 },
    { name: 'Aglio Olio', qty: 5, amount: 4250 },
  ]);
  assert.equal(r.total, 27830);
  assert.deepEqual(r.pay, { cash: 27830 });
});

test('payment and summary lines are not items', () => {
  const r = parseReport('NO. OF TRANS 87\nCASH 520.00\nNETS 3 410.00\nGST 9% 107.34\nGROSS SALES 12 99.00');
  assert.deepEqual(r.items, []);
});

test('empty text', () => {
  const r = parseReport('');
  assert.equal(r.total, null);
  assert.deepEqual(r.pay, {});
  assert.deepEqual(r.items, []);
});
