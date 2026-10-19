// Stall Ledger — daily close, item sales, stock and monthly P&L for a hawker stall.
// Data lives in Supabase (tables ledger_*, bucket ledger-photos); receipts are
// read on the phone with Tesseract.js (free, no API key), then parsed by ocr.js.
(() => {
  const cfg = window.LEDGER_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ledger-auth' },
  });

  // ── helpers ────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toCents = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const money = (c) => 'S$ ' + ((c || 0) / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fixed = (c) => c == null ? '' : (c / 100).toFixed(2);
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  };
  const fmtMonth = (m) => { const [y, mo] = m.split('-').map(Number); return `${MON[mo - 1]} ${y}`; };
  const qtyFmt = (q) => (Math.round((Number(q) || 0) * 100) / 100).toString();
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('toastRoot').replaceChildren(el);
    setTimeout(() => el.remove(), 2800);
  }

  const PAY = [['cash', 'Cash'], ['card', 'NETS/card'], ['paynow', 'PayNow/QR'], ['delivery', 'Delivery apps'], ['other', 'Other']];
  const MOVE_TYPES = { in: 'Stock in', count: 'Count', waste: 'Write-off', sale: 'Sold' };

  // ── data layer (Supabase) ──────────────────────────────────────────────
  const fromClosing = (r) => ({
    id: r.id, date: r.date, outletId: r.outlet_id, total: r.total, pay: r.pay || {}, orders: r.orders,
    note: r.note, photoPath: r.photo_path, sold: Array.isArray(r.items_sold) ? r.items_sold : [],
  });
  const fromItem = (r) => ({ id: r.id, name: r.name, unit: r.unit, category: r.category, low: r.low == null ? null : Number(r.low), qty: r.qty || {}, active: r.active });
  const fromMove = (r) => ({ id: r.id, itemId: r.item_id, itemName: r.item_name, unit: r.unit, outletId: r.outlet_id, type: r.type, qty: Number(r.qty), before: Number(r.before), after: Number(r.after), cost: r.cost, supplier: r.supplier, note: r.note, date: r.date, createdAt: r.created_at, closingId: r.closing_id });
  const fromRecipe = (r) => ({ dish: r.dish, name: r.name, lines: Array.isArray(r.lines) ? r.lines : [] });
  const fromExpense = (r) => ({ id: r.id, month: r.month, outletId: r.outlet_id, lines: r.lines || {}, note: r.note });
  const must = ({ data, error }) => { if (error) throw error; return data; };

  const api = {
    async settings() { return must(await sb.from('ledger_settings').select('data').eq('id', 'main').maybeSingle())?.data || null; },
    async saveSettings(data) { must(await sb.from('ledger_settings').upsert({ id: 'main', data, updated_at: new Date().toISOString() })); },
    async closings() { return must(await sb.from('ledger_closings').select('*').order('date', { ascending: false }).limit(400)).map(fromClosing); },
    async saveClosing(c) {
      must(await sb.from('ledger_closings').upsert({
        id: c.id, date: c.date, outlet_id: c.outletId, total: c.total, pay: c.pay, orders: c.orders,
        note: c.note, photo_path: c.photoPath, items_sold: c.sold, updated_at: new Date().toISOString(),
      }));
    },
    async items() { return must(await sb.from('ledger_items').select('*').order('name')).map(fromItem); },
    async recipes() { return must(await sb.from('ledger_recipes').select('*').order('name')).map(fromRecipe); },
    async saveRecipe(r) { must(await sb.from('ledger_recipes').upsert({ dish: r.dish, name: r.name, lines: r.lines, updated_at: new Date().toISOString() })); },
    async deleteRecipe(dish) { must(await sb.from('ledger_recipes').delete().eq('dish', dish)); },
    // Takes the day's items sold off stock using the recipes; only applies changes since the last save
    async applySales(closingId) {
      return must(await sb.rpc('ledger_apply_sales', { p_closing_id: closingId }))
        .map(r => ({ name: r.o_item_name, unit: r.o_unit, change: Number(r.o_change), after: Number(r.o_after) }));
    },
    async addItem(it) { must(await sb.from('ledger_items').insert(it)); },
    async updateItem(id, patch) { must(await sb.from('ledger_items').update(patch).eq('id', id)); },
    async moves() { return must(await sb.from('ledger_moves').select('*').order('created_at', { ascending: false }).limit(300)).map(fromMove); },
    async recordMove(p) {
      return fromMove(must(await sb.rpc('ledger_record_move', {
        p_item_id: p.itemId, p_outlet: p.outletId, p_type: p.type, p_qty: p.qty, p_cost: p.cost || 0,
        p_supplier: p.supplier || '', p_note: p.note || '', p_date: p.date,
      })));
    },
    async month(m) {
      const { start, end } = monthRange(m);
      const [cs, ms, es] = await Promise.all([
        sb.from('ledger_closings').select('*').gte('date', start).lte('date', end),
        sb.from('ledger_moves').select('*').gte('date', start).lte('date', end),
        sb.from('ledger_expenses').select('*').eq('month', m),
      ]);
      return { closings: must(cs).map(fromClosing), moves: must(ms).map(fromMove), expenses: must(es).map(fromExpense) };
    },
    async expense(id) { const r = must(await sb.from('ledger_expenses').select('*').eq('id', id).maybeSingle()); return r ? fromExpense(r) : null; },
    async saveExpense(e) {
      must(await sb.from('ledger_expenses').upsert({ id: e.id, month: e.month, outlet_id: e.outletId, lines: e.lines, note: e.note, updated_at: new Date().toISOString() }));
    },
    async uploadPhoto(blob, name) {
      const path = `${name}_${Date.now().toString(36)}.jpg`;
      must(await sb.storage.from('ledger-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
      return path;
    },
    async photoUrls(paths) {
      if (!paths.length) return {};
      const data = must(await sb.storage.from('ledger-photos').createSignedUrls(paths, 3600));
      return Object.fromEntries(data.filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
    },
  };

  // ── state ──────────────────────────────────────────────────────────────
  const S = {
    outlets: [{ id: 'a', name: 'Stall 1' }],
    outlet: lsGet('ledger.outlet', 'a'),
    closings: [], items: [], moves: [], recipes: [],
    photoBlob: null, photoPath: null, photoUploading: null,
    photoUrls: {},
    sold: [],   // items sold on the day being edited: [{name, qty, amount(cents)}]
    reportScope: 'all',
  };

  $('today').textContent = fmtDay(localDate());
  $('closeDate').value = localDate();
  $('reportMonth').value = localDate().slice(0, 7);

  // ── auth ───────────────────────────────────────────────────────────────
  let started = false;
  async function showForSession(session) {
    if (!session) {
      $('appView').hidden = true; $('loginView').hidden = false; started = false;
      return;
    }
    const { data: ok } = await sb.rpc('is_ledger_member');
    if (!ok) {
      $('loginMsg').innerHTML = `<div class="note bad">This account has not been given access yet. Ask the owner to add your email to the ledger.</div>`;
      await sb.auth.signOut();
      return;
    }
    $('whoami').textContent = `Signed in as ${session.user.email}`;
    $('loginView').hidden = true; $('appView').hidden = false;
    if (!started) { started = true; await refreshAll(); }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    $('loginMsg').innerHTML = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('loginEmail').value.trim(), password: $('loginPass').value });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) { $('loginMsg').innerHTML = `<div class="note bad">Wrong email or password. Please try again.</div>`; return; }
    await showForSession(data.session);
  });
  $('signOut').addEventListener('click', async () => { await sb.auth.signOut(); showForSession(null); });
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showForSession(null); });
  sb.auth.getSession().then(({ data }) => showForSession(data.session));

  // ── loading / refresh ──────────────────────────────────────────────────
  let refreshing = null;
  async function refreshAll() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const [settings, closings, items, moves, recipes] = await Promise.all([api.settings(), api.closings(), api.items(), api.moves(), api.recipes()]);
        if (Array.isArray(settings?.outlets) && settings.outlets.length) S.outlets = settings.outlets.map(o => ({ id: String(o.id), name: String(o.name) }));
        S.closings = closings; S.items = items; S.moves = moves; S.recipes = recipes;
        renderOutlets(); renderClose(); renderStock(); renderDishList(); renderRecipes();
        if (!$('tab-report').hidden) loadReport();
        $('statusNote').innerHTML = '';
      } catch (e) {
        console.error(e);
        $('statusNote').innerHTML = `<div class="note warn">No connection. What you see may be out of date; it updates when you are back online.</div>`;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) refreshAll(); });
  setInterval(() => { if (document.visibilityState === 'visible' && started) refreshAll(); }, 60_000);

  // ── tabs ───────────────────────────────────────────────────────────────
  const TABS = ['close', 'stock', 'report', 'settings'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'close';
    for (const t of TABS) $('tab-' + t).hidden = t !== name;
    document.querySelectorAll('nav.tabs button').forEach(b => {
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    lsSet('ledger.tab', name);
    if (name === 'report' && started) loadReport();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  showTab(lsGet('ledger.tab', 'close'));

  // ── stalls ─────────────────────────────────────────────────────────────
  const outletName = (id) => S.outlets.find(o => o.id === id)?.name || id;
  function renderOutlets() {
    if (!S.outlets.some(o => o.id === S.outlet)) S.outlet = S.outlets[0]?.id;
    const multi = S.outlets.length > 1;
    $('outletSeg').hidden = !multi;
    $('reportScope').hidden = !multi;
    if (!multi) S.reportScope = 'all';
    $('outletSeg').innerHTML = S.outlets.map(o =>
      `<button data-id="${esc(o.id)}" aria-pressed="${o.id === S.outlet}">${esc(o.name)}</button>`).join('');
    $('reportScope').innerHTML = [{ id: 'all', name: 'All stalls' }, ...S.outlets].map(o =>
      `<button data-id="${esc(o.id)}" aria-pressed="${o.id === S.reportScope}">${esc(o.name)}</button>`).join('');
    $('outletEdit').innerHTML = S.outlets.map((o, i) =>
      `<label class="f">Stall ${i + 1}<input id="outlet-name-${esc(o.id)}" data-id="${esc(o.id)}" value="${esc(o.name)}" maxlength="30"></label>`).join('');
  }
  $('outletSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.outlet = b.dataset.id; lsSet('ledger.outlet', S.outlet);
    renderOutlets(); renderClose(); renderStock();
  });
  $('reportScope').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.reportScope = b.dataset.id; renderOutlets(); loadReport();
  });
  renderOutlets();

  // ── daily close ────────────────────────────────────────────────────────
  const F = { total: $('f-total'), orders: $('f-orders'), cash: $('f-cash'), card: $('f-card'), paynow: $('f-paynow'), delivery: $('f-delivery'), other: $('f-other'), note: $('f-note') };
  const closeId = () => `${$('closeDate').value}_${S.outlet}`;
  const existingClose = () => S.closings.find(c => c.id === closeId());

  function checkSum() {
    const total = toCents(F.total.value);
    const sum = PAY.reduce((a, [k]) => a + (toCents(F[k].value) || 0), 0);
    const el = $('sumCheck');
    if (total == null && sum === 0) { el.innerHTML = ''; }
    else if (sum === 0) { el.innerHTML = `<div class="muted">Payments are optional; the total alone is fine.</div>`; }
    else {
      const diff = (total || 0) - sum;
      el.innerHTML = Math.abs(diff) < 1
        ? `<div class="sumline"><span class="muted">Payments add up to</span><span class="num" style="color:var(--good)">${money(sum)} ✓ matches</span></div>`
        : `<div class="note warn">Payments add up to <b class="num">${money(sum)}</b>, which is <b class="num">${money(Math.abs(diff))}</b> ${diff > 0 ? 'less' : 'more'} than the total. Please check.</div>`;
    }
    checkSold();
  }
  Object.values(F).forEach(inp => inp.addEventListener('input', checkSum));

  // Items sold
  function renderSold() {
    $('soldRows').innerHTML = S.sold.map((it, i) => `
      <div class="sold-row" data-i="${i}">
        <input id="sold-name-${i}" data-f="name" list="dish-list" value="${esc(it.name)}" placeholder="Dish, e.g. Chicken Chop" aria-label="Dish name">
        <div class="sold-nums">
          <label>Qty<input id="sold-qty-${i}" data-f="qty" class="money" inputmode="numeric" value="${it.qty ?? ''}" placeholder="0"></label>
          <label>S$<input id="sold-amt-${i}" data-f="amount" class="money" inputmode="decimal" value="${fixed(it.amount)}" placeholder="0.00"></label>
          <button class="icon-btn" data-remove type="button" aria-label="Remove dish">×</button>
        </div>
      </div>`).join('');
    checkSold();
  }
  function checkSold() {
    const el = $('soldCheck');
    const sum = S.sold.reduce((a, it) => a + (it.amount || 0), 0);
    const total = toCents(F.total.value);
    if (!S.sold.length || !sum) { el.innerHTML = ''; return; }
    const share = total ? Math.round(sum / total * 100) : null;
    el.innerHTML = `<div class="sumline"><span class="muted">${plural(S.sold.reduce((a, it) => a + (it.qty || 0), 0), 'item')} sold</span>
      <span class="num">${money(sum)}${share != null ? ` · ${share}% of total` : ''}</span></div>`;
  }
  $('addSold').addEventListener('click', () => {
    S.sold.push({ name: '', qty: null, amount: null });
    renderSold();
    $('sold-name-' + (S.sold.length - 1))?.focus();
  });
  $('soldRows').addEventListener('input', e => {
    const row = e.target.closest('.sold-row'); if (!row) return;
    const it = S.sold[+row.dataset.i]; const f = e.target.dataset.f;
    if (f === 'name') it.name = e.target.value;
    else if (f === 'qty') { const n = parseInt(e.target.value, 10); it.qty = Number.isFinite(n) ? n : null; }
    else if (f === 'amount') it.amount = toCents(e.target.value);
    // Typing a known dish with a qty: fill the amount from its usual price
    if ((f === 'name' || f === 'qty') && it.qty && it.amount == null) {
      const price = dishPrices()[it.name.trim().toLowerCase()];
      if (price) { it.amount = price * it.qty; row.querySelector('[data-f=amount]').value = fixed(it.amount); }
    }
    checkSold();
  });
  $('soldRows').addEventListener('click', e => {
    if (!e.target.closest('[data-remove]')) return;
    S.sold.splice(+e.target.closest('.sold-row').dataset.i, 1);
    renderSold();
  });
  // Dish names and their latest unit price, from earlier days
  function dishPrices() {
    const out = {};
    for (const c of S.closings) for (const it of c.sold) {
      const k = String(it.name).toLowerCase();
      if (!(k in out) && it.qty > 0 && it.amount > 0) out[k] = Math.round(it.amount / it.qty);
    }
    return out;
  }
  function renderDishList() {
    const names = new Map();
    for (const c of S.closings) for (const it of c.sold) if (it.name && !names.has(it.name.toLowerCase())) names.set(it.name.toLowerCase(), it.name);
    $('dish-list').innerHTML = [...names.values()].slice(0, 100).map(n => `<option value="${esc(n)}">`).join('');
  }

  function fillForm(c) {
    F.total.value = fixed(c?.total); F.orders.value = c?.orders ?? '';
    for (const [k] of PAY) F[k].value = fixed(c?.pay?.[k]);
    F.note.value = c?.note || '';
    S.sold = (c?.sold || []).map(it => ({ ...it }));
    renderSold();
    checkSum();
  }

  function renderClose() {
    const ex = existingClose();
    $('overwriteNote').innerHTML = ex
      ? `<div class="note info">${esc(outletName(S.outlet))} ${fmtDay($('closeDate').value)} is already recorded (${money(ex.total)}). Saving again updates it.</div>`
      : '';
    $('saveClose').textContent = ex ? 'Update this day' : 'Save this day';
    renderRecent();
  }
  $('closeDate').addEventListener('change', () => { $('saleNote').innerHTML = ''; const ex = existingClose(); if (ex) fillForm(ex); renderClose(); });

  async function renderRecent() {
    const rows = S.closings.filter(c => c.outletId === S.outlet).slice(0, 14);
    if (!rows.length) {
      $('recentClosings').innerHTML = `<div class="empty">Nothing recorded for ${esc(outletName(S.outlet))} yet. After closing, photograph the Z report and the first day shows up here.</div>`;
      return;
    }
    const need = rows.map(r => r.photoPath).filter(p => p && !S.photoUrls[p]);
    if (need.length) { try { Object.assign(S.photoUrls, await api.photoUrls(need)); } catch {} }
    $('recentClosings').innerHTML = rows.map(c => {
      const bits = [];
      if (c.orders) bits.push(plural(c.orders, 'order'));
      const pays = PAY.filter(([k]) => c.pay?.[k]).map(([k, n]) => `${n} ${fixed(c.pay[k])}`);
      bits.push(pays.length ? pays.join(' · ') : 'total only');
      if (c.sold.length) bits.push(plural(c.sold.length, 'dish', 'dishes'));
      return `
      <div class="it clickable" data-id="${esc(c.id)}">
        ${c.photoPath && S.photoUrls[c.photoPath] ? `<a href="${esc(S.photoUrls[c.photoPath])}" target="_blank" rel="noopener" data-photo><img class="thumb" src="${esc(S.photoUrls[c.photoPath])}" alt="Z report photo" loading="lazy"></a>` : `<span class="thumb"></span>`}
        <div class="main">
          <div class="title">${fmtDay(c.date)}</div>
          <div class="muted">${bits.join(' · ')}</div>
        </div>
        <div class="amt">${money(c.total)}</div>
      </div>`;
    }).join('');
  }
  $('recentClosings').addEventListener('click', e => {
    if (e.target.closest('[data-photo]')) return; // open the photo instead
    const it = e.target.closest('.it'); if (!it) return;
    const c = S.closings.find(x => x.id === it.dataset.id); if (!c) return;
    $('closeDate').value = c.date; $('saleNote').innerHTML = ''; fillForm(c); renderClose(); window.scrollTo(0, 0);
    toast('Loaded. Edit and save again to update.');
  });

  // Photo → shrink → upload + read text on the phone
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This photo could not be opened'));
      img.src = url;
    });
  }
  function drawScaled(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const toJpeg = (canvas, q = 0.8) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));

  $('photoInput').addEventListener('change', async () => {
    const file = $('photoInput').files?.[0];
    $('photoInput').value = '';
    if (!file) return;
    S.photoPath = null;
    const prev = $('photoPrev');
    prev.src = URL.createObjectURL(file); prev.hidden = false;
    $('photoHint').textContent = 'Use a different photo';
    try {
      const img = await loadImage(file);
      const blob = await toJpeg(drawScaled(img, 1600));
      S.photoBlob = blob;
      S.photoUploading = api.uploadPhoto(blob, closeId()).then(p => (S.photoPath = p)).catch(() => (S.photoPath = null));
      readReceipt(drawScaled(img, 2200));
    } catch (e) {
      $('aiNote').innerHTML = `<div class="note warn">${esc(e.message)}. Please type the numbers in.</div>`;
    }
  });

  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return tesseractLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = resolve; s.onerror = () => { tesseractLoading = null; reject(new Error('load')); };
      document.head.append(s);
    });
  }

  // Thermal receipts read better in high-contrast grayscale
  function prepForOcr(canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = Math.max(0, Math.min(255, (g - 128) * 1.6 + 128));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return canvas;
  }

  let ocrRun = 0;
  async function readReceipt(canvas) {
    const run = ++ocrRun;
    const note = (html) => { if (run === ocrRun) $('aiNote').innerHTML = html; };
    note(`<div class="note info"><span class="spin"></span> Reading the report… the first time downloads the reader, so it takes a little longer.</div>`);
    try {
      await loadTesseract();
      const worker = await window.Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') note(`<div class="note info"><span class="spin"></span> Reading the report… ${Math.round(m.progress * 100)}%</div>`);
        },
      });
      const { data } = await worker.recognize(prepForOcr(canvas));
      await worker.terminate();
      if (run !== ocrRun) return;
      const r = window.LedgerOCR.parseReport(data.text);
      const found = [];
      if (r.total != null) { F.total.value = fixed(r.total); found.push('total'); }
      for (const [k, n] of PAY) if (r.pay[k]) { F[k].value = fixed(r.pay[k]); found.push(n); }
      if (r.orders != null) { F.orders.value = r.orders; found.push('orders'); }
      if (r.items.length) { S.sold = r.items.map(it => ({ ...it })); renderSold(); found.push(plural(r.items.length, 'dish', 'dishes')); }
      checkSum();
      const raw = `<details><summary class="muted">Show the text that was read</summary><div class="ocr-raw">${esc(data.text.trim())}</div></details>`;
      if (!found.length) {
        note(`<div class="note warn">The photo was read but no amounts were found. Please type them in. A flat, well-lit photo works best.</div>${raw}`);
      } else if (r.date && r.date !== $('closeDate').value) {
        note(`<div class="note warn">Filled in: ${found.join(', ')}. The report is dated <b>${esc(fmtDay(r.date))}</b>, not the date selected. <button class="btn small" id="useOcrDate" type="button">Use ${esc(fmtDay(r.date))}</button></div>${raw}`);
        $('useOcrDate').onclick = () => { $('closeDate').value = r.date; renderClose(); toast('Date changed'); };
      } else {
        note(`<div class="note info">Filled in: ${found.join(', ')}. <b>Check them against the report</b> before saving.</div>${raw}`);
      }
    } catch (e) {
      console.error(e);
      note(`<div class="note warn">Could not read this report (maybe no internet). Please type the numbers in; the photo is still saved.</div>`);
    }
  }

  $('saveClose').addEventListener('click', async () => {
    const date = $('closeDate').value;
    const total = toCents(F.total.value);
    if (!date) return toast('Choose a date');
    if (total == null || total < 0) { F.total.focus(); return toast('Enter the total sales'); }
    const sold = S.sold
      .map(it => ({ name: String(it.name || '').trim().slice(0, 40), qty: it.qty || 0, amount: it.amount || 0 }))
      .filter(it => it.name && (it.qty > 0 || it.amount > 0));
    const btn = $('saveClose'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (S.photoUploading) await S.photoUploading;
      const prev = existingClose();
      const pay = {};
      for (const [k] of PAY) { const v = toCents(F[k].value); if (v) pay[k] = v; }
      const orders = parseInt(F.orders.value, 10);
      const id = closeId();
      await api.saveClosing({
        id, date, outletId: S.outlet, total, pay,
        orders: Number.isFinite(orders) ? orders : null,
        note: F.note.value.trim().slice(0, 200),
        photoPath: S.photoPath || prev?.photoPath || null,
        sold,
      });
      toast(`${outletName(S.outlet)} ${fmtDay(date)} saved: ${money(total)}`);
      await showStockUpdate(id, sold, prev);
      S.photoBlob = null; S.photoPath = null; S.photoUploading = null; ocrRun++;
      $('photoPrev').hidden = true; $('aiNote').innerHTML = ''; $('photoHint').textContent = 'Take a photo of the POS end-of-day report. The phone reads the numbers for you.';
      fillForm(null);
      await refreshAll();
    } catch (e) {
      console.error(e); toast('Could not save. Check your connection and try again.');
    } finally {
      btn.disabled = false; renderClose();
    }
  });

  // Take the day's sales off stock and say what changed
  async function showStockUpdate(closingId, sold, prev) {
    const el = $('saleNote');
    const hadSales = sold.length || prev?.sold?.length;
    if (!hadSales) { el.innerHTML = ''; return; }
    const known = new Set(S.recipes.map(r => r.dish));
    const noRecipe = sold.filter(it => it.qty > 0 && !known.has(it.name.trim().toLowerCase())).map(it => it.name);
    const missing = noRecipe.length
      ? `<div class="note warn">No recipe yet for ${noRecipe.map(esc).join(', ')}, so ${noRecipe.length === 1 ? 'it was' : 'they were'} not taken off stock. <button class="btn small" type="button" data-go-recipes>Set up recipes</button></div>`
      : '';
    try {
      const changes = await api.applySales(closingId);
      const lines = changes.map(c => `${esc(c.name)} ${c.change < 0 ? '−' : '+'}${qtyFmt(Math.abs(c.change))} ${esc(c.unit)} <span class="muted">(now ${qtyFmt(c.after)})</span>`);
      el.innerHTML = (lines.length
        ? `<div class="note info"><b>Stock updated from sales:</b><br>${lines.join('<br>')}</div>`
        : (S.recipes.length && sold.length && !noRecipe.length ? `<div class="note info">Stock already matches this day’s sales.</div>` : '')) + missing;
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="note warn">The day was saved, but stock could not be updated from sales. Save the day again to retry.</div>`;
    }
    el.querySelector('[data-go-recipes]')?.addEventListener('click', () => { showTab('stock'); $('recipeList').scrollIntoView({ block: 'center' }); });
  }

  // ── stock ──────────────────────────────────────────────────────────────
  const qtyOf = (it, outletId = S.outlet) => Number(it.qty?.[outletId] || 0);
  const levelOf = (it) => {
    const q = qtyOf(it);
    if (q <= 0) return 'out';
    if (it.low != null && q <= it.low) return 'low';
    return 'ok';
  };
  const LV_ORDER = { out: 0, low: 1, ok: 2 };
  const LV_LABEL = { out: 'Out', low: 'Low', ok: 'OK' };

  function renderStock() {
    const term = $('stockSearch').value.trim().toLowerCase();
    const items = S.items.filter(i => i.active !== false && (!term || i.name.toLowerCase().includes(term)))
      .sort((a, b) => (LV_ORDER[levelOf(a)] - LV_ORDER[levelOf(b)]) || a.name.localeCompare(b.name));
    const lows = S.items.filter(i => i.active !== false && levelOf(i) !== 'ok');
    $('lowSummary').innerHTML = lows.length
      ? `<div class="note warn"><b>Restock:</b> ${lows.map(i => esc(i.name)).join(', ')}</div>`
      : (S.items.length ? `<div class="note info">Stock levels are fine.</div>` : '');
    $('stockList').innerHTML = items.length ? items.map(i => {
      const lv = levelOf(i);
      return `<div class="it clickable" data-id="${esc(i.id)}">
        <div class="main"><div class="title">${esc(i.name)}</div>
          <div class="muted">${i.category ? esc(i.category) + ' · ' : ''}${i.low != null ? `alert below ${qtyFmt(i.low)} ${esc(i.unit)}` : 'no alert set'}</div></div>
        <span class="pill ${lv}">${LV_LABEL[lv]}</span>
        <div class="amt">${qtyFmt(qtyOf(i))} ${esc(i.unit)}</div>
      </div>`;
    }).join('') : `<div class="empty">${S.items.length ? 'No item matches that search.' : 'No stock items yet. Tap “+ New item” to add chicken chops, fries, pasta and other main ingredients.'}</div>`;

    const moves = S.moves.filter(m => m.outletId === S.outlet).slice(0, 20);
    $('moveList').innerHTML = moves.length ? moves.map(m => `
      <div class="it">
        <span class="pill ${m.type === 'in' ? 'ok' : m.type === 'waste' ? 'out' : m.type === 'sale' ? 'low' : ''}">${MOVE_TYPES[m.type] || m.type}</span>
        <div class="main"><div class="title">${esc(m.itemName)}</div>
          <div class="muted">${fmtDay(m.date)}${m.supplier ? ' · ' + esc(m.supplier) : ''}${m.note ? ' · ' + esc(m.note) : ''}</div></div>
        <div class="amt">${m.type === 'count' ? qtyFmt(m.after) + ' left' : (m.type === 'in' || m.qty < 0 ? '+' : '−') + qtyFmt(Math.abs(m.qty))} ${esc(m.unit)}${m.cost ? '<div class="muted">' + money(m.cost) + '</div>' : ''}</div>
      </div>`).join('') : `<div class="empty">Stock-ins, counts and write-offs show up here.</div>`;
  }
  $('stockSearch').addEventListener('input', renderStock);

  // ── recipes ────────────────────────────────────────────────────────────
  const itemById = (id) => S.items.find(i => i.id === id);
  const recipeText = (r) => r.lines.map(l => {
    const it = itemById(l.item_id);
    return it ? `${qtyFmt(l.qty)} ${esc(it.unit)} ${esc(it.name)}` : null;
  }).filter(Boolean).join(', ');

  function renderRecipes() {
    const byDish = new Map(S.recipes.map(r => [r.dish, r]));
    // Dishes sold recently that have no recipe yet
    const sold = new Map();
    for (const c of S.closings.slice(0, 60)) for (const it of c.sold) {
      const k = String(it.name).trim().toLowerCase();
      if (k && !byDish.has(k) && !sold.has(k)) sold.set(k, it.name);
    }
    const rows = [
      ...S.recipes.map(r => `<div class="it clickable" data-dish="${esc(r.dish)}">
        <div class="main"><div class="title">${esc(r.name)}</div><div class="muted">${recipeText(r) || 'No ingredients set'}</div></div>
        <span class="pill ok">Set</span></div>`),
      ...[...sold.values()].map(n => `<div class="it clickable" data-new="${esc(n)}">
        <div class="main"><div class="title">${esc(n)}</div><div class="muted">Sold recently · not taken off stock yet</div></div>
        <span class="pill low">No recipe</span></div>`),
    ];
    $('recipeList').innerHTML = rows.length ? rows.join('')
      : `<div class="empty">${S.items.length ? 'No recipes yet. Tap “+ New recipe”, e.g. Chicken Chop uses 1 pcs chicken chop and 0.15 kg fries.' : 'Add your stock items first, then set what each dish uses.'}</div>`;
  }
  $('recipeList').addEventListener('click', e => {
    const it = e.target.closest('.it'); if (!it) return;
    if (it.dataset.dish) editRecipe(S.recipes.find(r => r.dish === it.dataset.dish));
    else editRecipe(null, it.dataset.new);
  });
  $('addRecipe').addEventListener('click', () => editRecipe(null));

  function editRecipe(recipe, presetName = '') {
    const items = S.items.filter(i => i.active !== false);
    if (!items.length) { toast('Add stock items first, then set recipes'); return; }
    let lines = recipe ? recipe.lines.map(l => ({ ...l })) : [{ item_id: items[0].id, qty: 1 }];
    const options = (sel) => items.map(i => `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('');
    openSheet(`
      <div class="row"><h2 class="grow">${recipe ? 'Edit recipe' : 'New recipe'}</h2><button class="btn small" data-close type="button">Close</button></div>
      <label class="f">Dish name (as on the Z report)<input id="rc-name" maxlength="40" list="dish-list" value="${esc(recipe?.name || presetName)}" placeholder="e.g. Chicken Chop"></label>
      <div class="muted">One portion uses:</div>
      <div id="rc-lines" style="display:flex;flex-direction:column;gap:8px"></div>
      <button class="btn small" id="rc-add" type="button" style="align-self:flex-start">+ Add ingredient</button>
      <button class="btn primary block" id="rc-save" type="button">Save recipe</button>
      ${recipe ? `<button class="btn block danger" id="rc-del" type="button">Delete recipe</button>` : ''}
      <div class="muted">Only main ingredients are worth tracking, e.g. meat, fries, pasta, boxes.</div>
    `, (el, close) => {
      const draw = () => {
        el.querySelector('#rc-lines').innerHTML = lines.map((l, i) => `
          <div class="recipe-line" data-i="${i}">
            <select id="rc-item-${i}" data-f="item" aria-label="Stock item">${options(l.item_id)}</select>
            <input id="rc-qty-${i}" data-f="qty" class="money" inputmode="decimal" value="${l.qty ?? ''}" placeholder="1" aria-label="Quantity per portion">
            <button class="icon-btn" data-remove type="button" aria-label="Remove ingredient">×</button>
          </div>`).join('') || `<div class="muted">No ingredients. Add at least one.</div>`;
      };
      draw();
      el.querySelector('#rc-lines').addEventListener('input', e => {
        const row = e.target.closest('.recipe-line'); if (!row) return;
        const l = lines[+row.dataset.i];
        if (e.target.dataset.f === 'item') l.item_id = e.target.value;
        else l.qty = parseFloat(e.target.value);
      });
      el.querySelector('#rc-lines').addEventListener('change', e => {
        const row = e.target.closest('.recipe-line'); if (row && e.target.dataset.f === 'item') lines[+row.dataset.i].item_id = e.target.value;
      });
      el.querySelector('#rc-lines').addEventListener('click', e => {
        if (!e.target.closest('[data-remove]')) return;
        lines.splice(+e.target.closest('.recipe-line').dataset.i, 1); draw();
      });
      el.querySelector('#rc-add').onclick = () => { lines.push({ item_id: items[0].id, qty: 1 }); draw(); };
      el.querySelector('#rc-save').onclick = async () => {
        const name = el.querySelector('#rc-name').value.trim();
        if (!name) return toast('Enter the dish name');
        const clean = lines.filter(l => l.item_id && Number.isFinite(l.qty) && l.qty > 0).map(l => ({ item_id: l.item_id, qty: Math.round(l.qty * 1000) / 1000 }));
        if (!clean.length) return toast('Add at least one ingredient with a quantity');
        const dish = name.toLowerCase();
        try {
          if (recipe && recipe.dish !== dish) await api.deleteRecipe(recipe.dish); // renamed
          await api.saveRecipe({ dish, name, lines: clean });
          close(); toast(`Recipe saved. From now on, selling ${name} takes it off stock.`); refreshAll();
        } catch (e) { console.error(e); toast('Could not save the recipe'); }
      };
      const del = el.querySelector('#rc-del');
      if (del) del.onclick = async () => {
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete (stock already taken off stays)'; return; }
        try { await api.deleteRecipe(recipe.dish); close(); toast('Recipe deleted'); refreshAll(); } catch { toast('Could not delete'); }
      };
    });
  }

  function openSheet(html, onMount) {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) bg.remove(); });
    $('sheetRoot').replaceChildren(bg);
    onMount?.(bg.querySelector('.sheet'), () => bg.remove());
  }

  $('addItemBtn').addEventListener('click', () => editItem(null));

  function editItem(item) {
    openSheet(`
      <button class="btn small x" data-close type="button">Close</button>
      <h2>${item ? 'Edit item' : 'New item'}</h2>
      <label class="f">Name<input id="it-name" maxlength="40" placeholder="e.g. Chicken chop" value="${esc(item?.name || '')}"></label>
      <div class="fields">
        <label class="f">Unit<input id="it-unit" maxlength="10" placeholder="pcs / pack / kg" value="${esc(item?.unit || '')}"></label>
        <label class="f">Alert when below<input id="it-low" class="money" inputmode="decimal" placeholder="10" value="${item?.low ?? ''}"></label>
      </div>
      <label class="f">Category (optional)<input id="it-cat" maxlength="20" placeholder="Meat / Frozen / Sauce / Packaging" value="${esc(item?.category || '')}"></label>
      ${item ? '' : `<label class="f">How many you have now<input id="it-qty" class="money" inputmode="decimal" placeholder="0"></label>`}
      <button class="btn primary block" id="it-save" type="button">Save</button>
      ${item ? `<button class="btn block danger" id="it-hide" type="button">Stop using this item</button>` : ''}
    `, (el, close) => {
      el.querySelector('#it-name').focus();
      el.querySelector('#it-save').onclick = async () => {
        const name = el.querySelector('#it-name').value.trim();
        const unit = el.querySelector('#it-unit').value.trim() || 'pcs';
        const low = parseFloat(el.querySelector('#it-low').value);
        const category = el.querySelector('#it-cat').value.trim() || null;
        if (!name) return toast('Enter a name');
        try {
          if (item) await api.updateItem(item.id, { name, unit, low: Number.isFinite(low) ? low : null, category });
          else {
            const q = parseFloat(el.querySelector('#it-qty').value);
            await api.addItem({ name, unit, low: Number.isFinite(low) ? low : null, category, qty: Number.isFinite(q) ? { [S.outlet]: q } : {} });
          }
          close(); toast('Saved'); refreshAll();
        } catch (e) { console.error(e); toast('Could not save'); }
      };
      const hide = el.querySelector('#it-hide');
      if (hide) hide.onclick = async () => {
        if (hide.dataset.armed !== '1') { hide.dataset.armed = '1'; hide.textContent = 'Tap again to confirm (past records are kept)'; return; }
        try { await api.updateItem(item.id, { active: false }); close(); toast('Item hidden'); refreshAll(); } catch { toast('Could not update'); }
      };
    });
  }

  $('stockList').addEventListener('click', e => {
    const it = e.target.closest('.it'); if (!it) return;
    const item = S.items.find(i => i.id === it.dataset.id); if (item) openMove(item);
  });

  function openMove(item) {
    let type = 'in';
    const suppliers = [...new Set(S.moves.map(m => m.supplier).filter(Boolean))].slice(0, 20);
    const qtyLabel = { in: `How many came in (${item.unit})`, count: `How many are actually left (${item.unit})`, waste: `How many to write off (${item.unit})` };
    const saveLabel = { in: 'Record stock in', count: 'Record count', waste: 'Record write-off' };
    openSheet(`
      <div class="row"><h2 class="grow">${esc(item.name)}</h2><button class="btn small" data-close type="button">Close</button></div>
      <div class="muted">On hand: <b class="num">${qtyFmt(qtyOf(item))} ${esc(item.unit)}</b></div>
      <div class="typegrid" id="mv-types">
        <button class="btn" data-t="in" aria-pressed="true" type="button">Stock in</button>
        <button class="btn" data-t="count" aria-pressed="false" type="button">Count</button>
        <button class="btn" data-t="waste" aria-pressed="false" type="button">Write-off</button>
      </div>
      <label class="f"><span id="mv-qty-t">${esc(qtyLabel.in)}</span><input id="mv-qty" class="money" inputmode="decimal" placeholder="0"></label>
      <div class="fields" id="mv-in-fields">
        <label class="f">Total price S$<input id="mv-cost" class="money" inputmode="decimal" placeholder="0.00"></label>
        <label class="f">Supplier<input id="mv-sup" maxlength="40" placeholder="e.g. Sheng Siong" list="sup-list"></label>
      </div>
      <datalist id="sup-list">${suppliers.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <label class="f">Date<input id="mv-date" type="date" value="${localDate()}"></label>
      <label class="f">Note (optional)<input id="mv-note" maxlength="80"></label>
      <div id="mv-preview" class="muted"></div>
      <button class="btn primary block" id="mv-save" type="button">${saveLabel.in}</button>
      <button class="btn block" id="mv-edit" type="button">Edit item details</button>
    `, (el, close) => {
      const qInp = el.querySelector('#mv-qty');
      const preview = () => {
        const q = parseFloat(qInp.value); const cur = qtyOf(item);
        if (!Number.isFinite(q)) { el.querySelector('#mv-preview').textContent = ''; return; }
        const after = type === 'in' ? cur + q : type === 'waste' ? cur - q : q;
        const extra = type === 'count' && after !== cur ? ` (${after < cur ? 'short by' : 'over by'} ${qtyFmt(Math.abs(cur - after))} ${item.unit} vs the system)` : '';
        el.querySelector('#mv-preview').textContent = `After saving: ${qtyFmt(after)} ${item.unit}${extra}`;
      };
      qInp.addEventListener('input', preview);
      el.querySelector('#mv-types').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        type = b.dataset.t;
        el.querySelectorAll('#mv-types button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        el.querySelector('#mv-in-fields').hidden = type !== 'in';
        el.querySelector('#mv-qty-t').textContent = qtyLabel[type];
        el.querySelector('#mv-save').textContent = saveLabel[type];
        preview();
      };
      el.querySelector('#mv-edit').onclick = () => editItem(item);
      el.querySelector('#mv-save').onclick = async () => {
        const q = parseFloat(qInp.value);
        if (!Number.isFinite(q) || q < 0 || (type !== 'count' && q === 0)) { qInp.focus(); return toast('Enter a quantity'); }
        const btn = el.querySelector('#mv-save'); btn.disabled = true;
        try {
          const mv = await api.recordMove({
            itemId: item.id, outletId: S.outlet, type, qty: q,
            cost: type === 'in' ? (toCents(el.querySelector('#mv-cost').value) || 0) : 0,
            supplier: type === 'in' ? el.querySelector('#mv-sup').value.trim() : '',
            note: el.querySelector('#mv-note').value.trim(),
            date: el.querySelector('#mv-date').value || localDate(),
          });
          close(); toast(`${item.name}: ${MOVE_TYPES[type].toLowerCase()} recorded, now ${qtyFmt(mv.after)} ${item.unit}`);
          refreshAll();
        } catch (e) { console.error(e); btn.disabled = false; toast('Could not record. Please try again.'); }
      };
    });
  }

  // ── monthly report (profit & loss) ─────────────────────────────────────
  const EXPENSES = [
    ['rent', 'Rent'], ['wages', 'Wages / CPF'], ['utilities', 'Water & electricity'], ['gas', 'Gas'],
    ['commission', 'Delivery app commission'], ['misc', 'Cleaning / misc'],
  ];
  function monthRange(m) {
    const [y, mo] = m.split('-').map(Number);
    const dim = new Date(y, mo, 0).getDate();
    return { start: `${m}-01`, end: `${m}-${pad(dim)}`, y, mo, dim };
  }
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
  const scopeOutlets = () => S.reportScope === 'all' ? S.outlets.map(o => o.id) : [S.reportScope];
  const scopeLabel = () => S.reportScope === 'all' ? (S.outlets.length > 1 ? 'All stalls' : outletName(S.outlets[0]?.id)) : outletName(S.reportScope);

  async function fetchMonth(m) {
    const outs = new Set(scopeOutlets());
    const d = await api.month(m);
    const pick = (rows) => rows.filter(x => outs.has(x.outletId));
    return { closings: pick(d.closings), moves: pick(d.moves), expenses: pick(d.expenses) };
  }

  // Item sales across the days in a month, merged by name (case-insensitive)
  function itemSales(closings) {
    const by = new Map();
    for (const c of closings) for (const it of c.sold) {
      const k = String(it.name).trim().toLowerCase(); if (!k) continue;
      const row = by.get(k) || { name: String(it.name).trim(), qty: 0, amount: 0, days: 0 };
      row.qty += it.qty || 0; row.amount += it.amount || 0; row.days++;
      by.set(k, row);
    }
    return [...by.values()].sort((a, b) => b.amount - a.amount || b.qty - a.qty);
  }

  function summarize(data) {
    const sales = data.closings.reduce((a, c) => a + (c.total || 0), 0);
    const buys = data.moves.filter(m => m.type === 'in');
    const cogs = buys.reduce((a, m) => a + (m.cost || 0), 0);
    const exp = Object.fromEntries(EXPENSES.map(([k]) => [k, data.expenses.reduce((a, e) => a + (e.lines?.[k] || 0), 0)]));
    const opex = Object.values(exp).reduce((a, b) => a + b, 0);
    const gross = sales - cogs;
    const days = new Set(data.closings.map(c => c.date)).size;
    const orders = data.closings.reduce((a, c) => a + (c.orders || 0), 0);
    return { sales, cogs, exp, opex, gross, net: gross - opex, days, orders, buys };
  }

  let reportSeq = 0;
  let lastReport = null;
  async function loadReport() {
    const seq = ++reportSeq;
    const month = $('reportMonth').value || localDate().slice(0, 7);
    $('reportBody').innerHTML = `<div class="empty"><span class="spin"></span> Working it out…</div>`;
    try {
      const [cur, prev] = await Promise.all([fetchMonth(month), fetchMonth(prevMonth(month))]);
      if (seq !== reportSeq) return;
      lastReport = { month, data: cur, sum: summarize(cur), prev: summarize(prev), items: itemSales(cur.closings), prevItems: itemSales(prev.closings) };
      renderReport();
    } catch (e) {
      console.error(e);
      if (seq === reportSeq) $('reportBody').innerHTML = `<div class="note bad">Could not load the report. Check your connection and try again.</div>`;
    }
  }
  $('reportMonth').addEventListener('change', loadReport);

  function change(cur, prev) {
    if (!prev) return '';
    const d = Math.round((cur - prev) / Math.abs(prev) * 100);
    if (!Number.isFinite(d) || d === 0) return `<span class="chg">same as last month</span>`;
    return `<span class="chg ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}% vs last month</span>`;
  }

  function renderReport() {
    const { month, data, sum, prev, items, prevItems } = lastReport;
    const { dim } = monthRange(month);
    const thisMonth = localDate().slice(0, 7);
    const elapsed = month === thisMonth ? new Date().getDate() : month > thisMonth ? 0 : dim;
    const missing = [];
    const dayRows = [];
    for (let i = 1; i <= dim; i++) {
      const date = `${month}-${pad(i)}`;
      const cs = data.closings.filter(c => c.date === date);
      if (!cs.length) { if (i <= elapsed) missing.push(i); continue; }
      dayRows.push({
        date,
        total: cs.reduce((a, c) => a + (c.total || 0), 0),
        orders: cs.reduce((a, c) => a + (c.orders || 0), 0),
        note: cs.map(c => c.note).filter(Boolean).join('; '),
      });
    }
    const maxDay = Math.max(1, ...dayRows.map(r => r.total));
    const byWeekday = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    for (const r of dayRows) { const w = new Date(r.date + 'T00:00:00').getDay(); byWeekday[w].sum += r.total; byWeekday[w].n++; }
    const wkTop = Math.max(1, ...byWeekday.map(x => x.n ? x.sum / x.n : 0));
    const payTotals = PAY.map(([k, n]) => [k, n, data.closings.reduce((a, c) => a + (c.pay?.[k] || 0), 0)]).filter(([, , v]) => v > 0);
    const bySupplier = {}, byItem = {};
    for (const m of sum.buys) {
      const s = m.supplier || 'No supplier entered';
      bySupplier[s] = (bySupplier[s] || 0) + (m.cost || 0);
      byItem[m.itemName] = (byItem[m.itemName] || 0) + (m.cost || 0);
    }
    const wastes = data.moves.filter(m => m.type === 'waste');
    const sortDesc = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    const editable = S.reportScope !== 'all' || S.outlets.length === 1;
    const expBtn = editable
      ? `<button class="btn" id="editExp" type="button">${sum.opex ? 'Edit this month’s expenses' : 'Enter this month’s expenses (rent, wages, utilities…)'}</button>`
      : `<div class="muted">To enter expenses, choose a stall above first.</div>`;

    $('exportBtn').hidden = false;
    if (!data.closings.length && !data.moves.length && !sum.opex) {
      $('reportBody').innerHTML = `<div class="empty">Nothing recorded for ${fmtMonth(month)} yet. Record each day after closing and this page works out sales, costs and profit.</div>${editable ? expBtn : ''}`;
      $('exportBtn').hidden = true;
      $('editExp')?.addEventListener('click', editExpenses);
      return;
    }

    const line = (label, v, cls = '', extra = '') =>
      `<div class="pl-row ${cls}"><span>${label}${extra}</span><span class="num">${v < 0 ? '−' : ''}${money(Math.abs(v))}</span></div>`;

    // Item sales
    const itemDays = data.closings.filter(c => c.sold.length).length;
    const itemTotal = items.reduce((a, it) => a + it.amount, 0);
    const itemQty = items.reduce((a, it) => a + it.qty, 0);
    const prevByName = new Map(prevItems.map(it => [it.name.toLowerCase(), it]));
    const itemCard = items.length ? `<div class="card"><h3>Item sales</h3>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Sales</th><th class="r">Share</th><th class="r">Avg price</th></tr></thead>
        <tbody>${items.map(it => {
          const p = prevByName.get(it.name.toLowerCase());
          const d = p && p.qty ? Math.round((it.qty - p.qty) / p.qty * 100) : null;
          return `<tr><td>${esc(it.name)}${d != null && d !== 0 ? `<div class="chg ${d > 0 ? 'up' : 'down'}" style="margin:0">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}% qty</div>` : ''}</td>
            <td class="r num">${it.qty}</td><td class="r num">${fixed(it.amount)}</td>
            <td class="r num muted">${pct(it.amount, itemTotal)}%</td>
            <td class="r num">${it.qty ? fixed(Math.round(it.amount / it.qty)) : ''}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="r num">${itemQty}</td><td class="r num">${fixed(itemTotal)}</td><td></td><td></td></tr></tfoot>
      </table></div>
      <div class="muted">Item sales were recorded on ${plural(itemDays, 'day')} of ${sum.days}.${sum.sales && itemDays === sum.days ? ` They cover ${pct(itemTotal, sum.sales)}% of total sales.` : ''}</div>
    </div>` : (sum.days ? `<div class="card"><h3>Item sales</h3><div class="muted">No item sales recorded this month. Add them under “Items sold” when closing each day, or let the photo fill them in if your Z report lists items.</div></div>` : '');

    $('reportBody').innerHTML = `
      <div class="card">
        <h3>Profit &amp; loss · ${fmtMonth(month)} · ${esc(scopeLabel())}</h3>
        <div class="pl">
          ${line('Sales', sum.sales, 'head', change(sum.sales, prev.sales))}
          ${line('Less: food purchases', -sum.cogs, 'sub', sum.sales ? ` <span class="muted">(${pct(sum.cogs, sum.sales)}%)</span>` : '')}
          ${line('Gross profit', sum.gross, 'total', sum.sales ? ` <span class="muted">margin ${pct(sum.gross, sum.sales)}%</span>` : '')}
          ${EXPENSES.filter(([k]) => sum.exp[k]).map(([k, n]) => line('Less: ' + n, -sum.exp[k], 'sub')).join('')}
          ${sum.opex ? '' : `<div class="pl-row sub"><span class="muted">No expenses entered for this month yet</span><span></span></div>`}
          ${line('Net profit', sum.net, 'net ' + (sum.net < 0 ? 'neg' : ''), change(sum.net, prev.net))}
        </div>
        ${expBtn}
        <div class="muted">Food cost uses the stock-ins recorded this month. If stock on hand is very different at the start and end of the month, profit will be off by that much.</div>
      </div>

      <div class="kpis">
        <div class="kpi"><div class="k">Days open</div><div class="v">${sum.days}<span class="unit"> / ${elapsed}</span></div>
          <div class="s">${missing.length ? `${plural(missing.length, 'day')} not recorded` : 'Every day recorded'}</div></div>
        <div class="kpi"><div class="k">Average per day</div><div class="v">${money(sum.days ? Math.round(sum.sales / sum.days) : 0)}</div>
          <div class="s">${change(sum.days ? sum.sales / sum.days : 0, prev.days ? prev.sales / prev.days : 0)}</div></div>
        <div class="kpi"><div class="k">Orders</div><div class="v">${sum.orders || '—'}</div>
          <div class="s">${sum.orders ? 'average ' + money(Math.round(sum.sales / sum.orders)) + ' each' : 'no order counts entered'}</div></div>
        <div class="kpi"><div class="k">Write-offs</div><div class="v">${wastes.length}</div>
          <div class="s">${wastes.length ? wastes.slice(0, 3).map(w => esc(w.itemName)).join(', ') : 'none'}</div></div>
      </div>

      ${missing.length && sum.days ? `<div class="note warn">No record for: ${missing.map(d => `${d} ${MON[+month.slice(5) - 1]}`).join(', ')}. Ignore rest days; if the stall was open, add them.</div>` : ''}

      ${itemCard}

      <div class="card">
        <h3>Daily sales</h3>
        <div class="daybars" role="img" aria-label="Daily sales bar chart">${Array.from({ length: dim }, (_, i) => {
          const r = dayRows.find(x => x.date === `${month}-${pad(i + 1)}`);
          return `<span class="${r ? '' : 'none'}" style="height:${r ? Math.max(4, r.total / maxDay * 100) : 4}%" title="${i + 1} ${MON[+month.slice(5) - 1]}: ${r ? money(r.total) : 'no record'}"></span>`;
        }).join('')}</div>
        <div class="axis"><span>1</span><span>${Math.ceil(dim / 2)}</span><span>${dim}</span></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Date</th><th class="r">Sales</th><th class="r">Orders</th><th class="r">Per order</th></tr></thead>
          <tbody>${dayRows.map(r => `<tr><td>${fmtDay(r.date)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td>
            <td class="r num">${fixed(r.total)}</td><td class="r num">${r.orders || ''}</td>
            <td class="r num">${r.orders ? fixed(Math.round(r.total / r.orders)) : ''}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="r num">${fixed(sum.sales)}</td><td class="r num">${sum.orders || ''}</td><td></td></tr></tfoot>
        </table></div>
      </div>

      ${dayRows.length >= 7 ? `<div class="card"><h3>Best days of the week</h3>
        ${[1, 2, 3, 4, 5, 6, 0].map(w => {
          const b = byWeekday[w]; const avg = b.n ? Math.round(b.sum / b.n) : 0;
          return `<div class="wk"><span>${DOW[w]}</span><div class="bar"><span style="width:${avg / wkTop * 100}%"></span></div><span class="num">${b.n ? fixed(avg) : '—'}</span></div>`;
        }).join('')}<div class="muted">Average sales on days with a record.</div></div>` : ''}

      ${payTotals.length ? `<div class="card"><h3>Payments</h3><div class="tbl-wrap"><table class="tbl"><tbody>
        ${payTotals.map(([, n, v]) => `<tr><td>${n}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${pct(v, sum.sales)}%</td></tr>`).join('')}
        </tbody></table></div>
        ${payTotals.some(([k]) => k === 'cash') ? `<div class="muted">Cash of ${money(payTotals.find(([k]) => k === 'cash')[2])} should match the cash banked this month.</div>` : ''}</div>` : ''}

      ${sum.buys.length ? `<div class="card"><h3>Purchases</h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Supplier</th><th class="r">Amount</th><th class="r">Share</th></tr></thead><tbody>
          ${sortDesc(bySupplier).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${pct(v, sum.cogs)}%</td></tr>`).join('')}
        </tbody></table></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Stock item</th><th class="r">Amount</th><th class="r">% of sales</th></tr></thead><tbody>
          ${sortDesc(byItem).slice(0, 10).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${sum.sales ? pct(v, sum.sales) + '%' : ''}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
    `;
    $('editExp')?.addEventListener('click', editExpenses);
  }

  function editExpenses() {
    const month = lastReport?.month || $('reportMonth').value;
    const outletId = S.reportScope === 'all' ? S.outlets[0].id : S.reportScope;
    const existing = lastReport?.data.expenses.find(e => e.outletId === outletId);
    openSheet(`
      <div class="row"><h2 class="grow">Expenses · ${fmtMonth(month)}</h2><button class="btn small" data-close type="button">Close</button></div>
      <div class="muted">${esc(outletName(outletId))} · enter what was actually paid this month; leave blank if none.</div>
      <div class="fields">${EXPENSES.map(([k, n]) =>
        `<label class="f">${n} S$<input class="money" id="exp-${k}" inputmode="decimal" placeholder="0.00" value="${fixed(existing?.lines?.[k] || null)}"></label>`).join('')}</div>
      <label class="f">Note<input id="exp-note" maxlength="120" placeholder="e.g. wages include 2 helpers" value="${esc(existing?.note || '')}"></label>
      <button class="btn primary block" id="exp-save" type="button">Save expenses</button>
      <button class="btn block" id="exp-copy" type="button">Copy last month’s amounts</button>
    `, (el, close) => {
      el.querySelector('#exp-copy').onclick = async () => {
        try {
          const prev = await api.expense(`${prevMonth(month)}_${outletId}`);
          if (!prev) return toast('No expenses entered last month');
          for (const [k] of EXPENSES) el.querySelector('#exp-' + k).value = fixed(prev.lines[k] || null);
          toast('Copied last month’s amounts. Check them before saving.');
        } catch { toast('Could not load last month'); }
      };
      el.querySelector('#exp-save').onclick = async () => {
        const lines = {};
        for (const [k] of EXPENSES) { const v = toCents(el.querySelector('#exp-' + k).value); if (v) lines[k] = v; }
        try {
          await api.saveExpense({ id: `${month}_${outletId}`, month, outletId, lines, note: el.querySelector('#exp-note').value.trim() });
          close(); toast('Expenses saved'); loadReport();
        } catch (e) { console.error(e); toast('Could not save'); }
      };
    });
  }

  $('exportBtn').addEventListener('click', () => {
    if (!lastReport) return;
    const { month, data, sum, items } = lastReport;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row = (...cells) => cells.map(q).join(',');
    const L = [row(`Monthly report ${month}`, scopeLabel())];
    L.push('', row('Profit & loss', 'Amount (S$)'));
    L.push(row('Sales', fixed(sum.sales)), row('Food purchases', fixed(sum.cogs)), row('Gross profit', fixed(sum.gross)));
    for (const [k, n] of EXPENSES) if (sum.exp[k]) L.push(row(n, fixed(sum.exp[k])));
    L.push(row('Total expenses', fixed(sum.opex)), row('Net profit', fixed(sum.net)));
    if (items.length) {
      L.push('', row('Item', 'Qty', 'Sales (S$)', 'Avg price (S$)'));
      for (const it of items) L.push(row(it.name, it.qty, fixed(it.amount), it.qty ? fixed(Math.round(it.amount / it.qty)) : ''));
    }
    L.push('', row('Date', 'Stall', 'Sales', ...PAY.map(([, n]) => n), 'Orders', 'Note'));
    for (const c of [...data.closings].sort((a, b) => a.date.localeCompare(b.date)))
      L.push(row(c.date, outletName(c.outletId), fixed(c.total), ...PAY.map(([k]) => fixed(c.pay?.[k])), c.orders ?? '', c.note));
    L.push('', row('Date', 'Stall', 'Type', 'Stock item', 'Quantity', 'Amount', 'Supplier', 'Note'));
    for (const m of [...data.moves].sort((a, b) => a.date.localeCompare(b.date)))
      L.push(row(m.date, outletName(m.outletId), MOVE_TYPES[m.type], m.itemName, `${qtyFmt(m.type === 'count' ? m.after : m.qty)} ${m.unit}`, m.cost ? fixed(m.cost) : '', m.supplier, m.note));
    const blob = new Blob(['﻿' + L.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stall-ledger-${month}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ── settings ───────────────────────────────────────────────────────────
  $('addOutlet').addEventListener('click', () => {
    S.outlets.push({ id: 'o' + Date.now().toString(36), name: `Stall ${S.outlets.length + 1}` });
    renderOutlets();
    toast('Added. Rename it, then tap “Save names”.');
  });
  $('saveOutlets').addEventListener('click', async () => {
    document.querySelectorAll('#outletEdit input').forEach(inp => {
      const o = S.outlets.find(x => x.id === inp.dataset.id);
      if (o) o.name = inp.value.trim() || o.name;
    });
    try { await api.saveSettings({ outlets: S.outlets }); toast('Stalls saved'); } catch { toast('Could not save'); }
    renderOutlets(); renderClose(); renderStock();
  });

  // ── offline shell ──────────────────────────────────────────────────────
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
