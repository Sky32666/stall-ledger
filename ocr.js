// Parse the text of a POS end-of-day report (Z report / daily summary) into
// numbers for the daily-close form. The text comes from Tesseract.js running
// on the phone, so expect OCR noise: O/0, S/5 swaps, stray spaces in amounts.
//
// Pure functions only (no DOM), so this file also runs under Node for tests.

(function (root) {
  // Checked in order: the first category whose keyword appears on a line wins.
  // Delivery and e-wallet names go first because they often contain "PAY" or "CARD".
  const CATEGORIES = [
    ['delivery', ['GRABFOOD', 'GRAB FOOD', 'FOODPANDA', 'FOOD PANDA', 'DELIVEROO', 'DELIVERY']],
    ['paynow',   ['PAYNOW', 'PAY NOW', 'SGQR', 'GRABPAY', 'GRAB PAY', 'SHOPEEPAY', 'SHOPEE', 'FAVEPAY', 'E-WALLET', 'EWALLET', 'QR']],
    ['card',     ['NETS', 'VISA', 'MASTER', 'AMEX', 'UNIONPAY', 'CREDIT', 'DEBIT', 'CARD', 'EZLINK', 'EZ-LINK', 'CEPAS', 'CONTACTLESS']],
    ['cash',     ['CASH']],
  ];

  // Lines that carry money but are not sales or payments.
  const IGNORE = ['GST', 'TAX', 'SVC', 'SERVICE CHARGE', 'DISCOUNT', 'DISC', 'VOID', 'REFUND', 'ROUNDING', 'ROUND',
    'CHANGE', 'FLOAT', 'OPENING', 'DRAWER', 'PAID OUT', 'PAID IN', 'CASH IN', 'CASH OUT', 'TIPS', 'AVG', 'AVERAGE', 'COUNT'];

  // Sales total, best first. "NET SALES" beats a bare "TOTAL".
  const TOTAL_KEYS = ['NET SALES', 'NETT SALES', 'NET SALE', 'TOTAL NET', 'NET TOTAL', 'TOTAL SALES', 'GRAND TOTAL',
    'TOTAL COLLECTION', 'TOTAL COLLECTED', 'TOTAL PAYMENT', 'SALES TOTAL', 'TOTAL'];

  const ORDER_KEYS = ['NO. OF TRANS', 'NO OF TRANS', 'TRANSACTION', 'TRANS COUNT', 'TXN', 'RECEIPTS', 'RECEIPT COUNT',
    'NO. OF BILLS', 'NO OF BILLS', 'BILLS', 'ORDERS', 'CHECKS', 'GUEST'];

  function normalize(line) {
    return line.toUpperCase()
      .replace(/[|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Money on a line: the right-most amount with exactly two decimals.
  // Handles "S$1,234.50", "$ 85.00", "1 234.50", "85,00" (comma decimal).
  function amountsIn(line) {
    const fixed = line
      .replace(/(\d)[oO](?=\d|[.,]\d)/g, '$10')       // 1O5.00 → 105.00
      .replace(/(\d)\s+(?=\d{3}[.,]\d{2}\b)/g, '$1')    // 1 234.50 → 1234.50
      .replace(/(\d),(\d{2})\b(?![.,]\d)/g, '$1.$2');  // 85,00 → 85.00
    const out = [];
    const re = /(-)?\s?(?:S?\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g;
    let m;
    while ((m = re.exec(fixed))) {
      const cents = Math.round(parseFloat(m[2].replace(/,/g, '') + '.' + m[3]) * 100);
      out.push(m[1] ? -cents : cents);
    }
    return out;
  }

  function lastAmount(line) {
    const a = amountsIn(line);
    return a.length ? a[a.length - 1] : null;
  }

  // For keyword matching only: OCR often reads O as 0 inside words (GRABF00D, CA5H is rarer)
  function wordsOf(line) {
    return line.replace(/([A-Z])(0+)(?=[A-Z])/g, (_, a, z) => a + 'O'.repeat(z.length));
  }

  function hasKey(line, key) {
    // Short keys like QR / TXN must match as whole words
    if (key.length <= 4) return new RegExp(`(^|[^A-Z])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z]|$)`).test(line);
    return line.includes(key);
  }

  function findDate(lines) {
    for (const raw of lines) {
      const line = raw.replace(/(?<=\d)[oO]|[oO](?=\d)/g, '0');
      let m = line.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
      if (m) return iso(+m[1], +m[2], +m[3]);
      m = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2})\b/);
      if (m) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return iso(y, +m[2], +m[1]); // Singapore receipts are day/month/year
      }
      m = line.match(/\b(\d{1,2})[\s-]?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[\s-,]*(20\d{2})\b/i);
      if (m) return iso(+m[3], 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(m[2].toUpperCase()) / 3 + 1, +m[1]);
    }
    return null;
  }

  function iso(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /**
   * @param {string} text OCR output
   * @returns {{ total: number|null, pay: {cash?,card?,paynow?,delivery?}, orders: number|null,
   *             date: string|null, matched: Array<{line: string, field: string, cents?: number}> }}
   *          amounts in cents
   */
  function parseReport(text) {
    const lines = String(text || '').split(/\r?\n/).map(normalize).filter(Boolean);
    const pay = {};
    const matched = [];
    let total = null, totalRank = Infinity, orders = null;

    for (const line of lines) {
      const words = wordsOf(line);
      if (orders == null) {
        const ok = ORDER_KEYS.find(k => hasKey(words, k));
        if (ok && !/\.\d{2}\b/.test(line.slice(line.indexOf(ok)))) {
          const n = line.slice(line.indexOf(ok) + ok.length).match(/\b(\d{1,4})\b/);
          if (n) { orders = +n[1]; matched.push({ line, field: 'orders' }); continue; }
        }
      }

      const cents = lastAmount(line);
      if (cents == null || cents <= 0) continue;
      if (IGNORE.some(k => hasKey(words, k))) continue;

      const rank = TOTAL_KEYS.findIndex(k => hasKey(words, k));
      const cat = CATEGORIES.find(([, keys]) => keys.some(k => hasKey(words, k)));

      if (cat) {
        // "CASH TOTAL 85.00" is the cash line, not the day's total
        pay[cat[0]] = (pay[cat[0]] || 0) + cents;
        matched.push({ line, field: cat[0], cents });
      } else if (rank >= 0 && rank < totalRank) {
        total = cents; totalRank = rank;
        matched.push({ line, field: 'total', cents });
      }
    }

    // A payment line repeated in a summary block would double count: if the
    // payments add up to twice the total, halve them.
    const paySum = Object.values(pay).reduce((a, b) => a + b, 0);
    if (total && paySum === total * 2) for (const k in pay) pay[k] = pay[k] / 2;
    // No explicit total but payments found: use their sum
    if (total == null && paySum > 0) total = paySum;

    return { total, pay, orders, date: findDate(lines), matched };
  }

  const api = { parseReport, amountsIn, findDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LedgerOCR = api;
})(typeof window !== 'undefined' ? window : globalThis);
