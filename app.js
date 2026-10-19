// 档口账本 — daily close, stock and monthly P&L for a hawker stall.
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
  const fmtDay = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
  };
  const qtyFmt = (q) => (Math.round((Number(q) || 0) * 100) / 100).toString();
  const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('toastRoot').replaceChildren(el);
    setTimeout(() => el.remove(), 2800);
  }

  const PAY = [['cash', '现金'], ['card', 'NETS/刷卡'], ['paynow', 'PayNow/QR'], ['delivery', '外卖平台'], ['other', '其他']];
  const MOVE_TYPES = { in: '进货', count: '盘点', waste: '报废' };

  // ── data layer (Supabase) ──────────────────────────────────────────────
  const fromClosing = (r) => ({ id: r.id, date: r.date, outletId: r.outlet_id, total: r.total, pay: r.pay || {}, orders: r.orders, note: r.note, photoPath: r.photo_path });
  const fromItem = (r) => ({ id: r.id, name: r.name, unit: r.unit, category: r.category, low: r.low == null ? null : Number(r.low), qty: r.qty || {}, active: r.active });
  const fromMove = (r) => ({ id: r.id, itemId: r.item_id, itemName: r.item_name, unit: r.unit, outletId: r.outlet_id, type: r.type, qty: Number(r.qty), before: Number(r.before), after: Number(r.after), cost: r.cost, supplier: r.supplier, note: r.note, date: r.date, createdAt: r.created_at });
  const fromExpense = (r) => ({ id: r.id, month: r.month, outletId: r.outlet_id, lines: r.lines || {}, note: r.note });
  const must = ({ data, error }) => { if (error) throw error; return data; };

  const api = {
    async settings() { return must(await sb.from('ledger_settings').select('data').eq('id', 'main').maybeSingle())?.data || null; },
    async saveSettings(data) { must(await sb.from('ledger_settings').upsert({ id: 'main', data, updated_at: new Date().toISOString() })); },
    async closings() { return must(await sb.from('ledger_closings').select('*').order('date', { ascending: false }).limit(400)).map(fromClosing); },
    async saveClosing(c) {
      must(await sb.from('ledger_closings').upsert({
        id: c.id, date: c.date, outlet_id: c.outletId, total: c.total, pay: c.pay, orders: c.orders,
        note: c.note, photo_path: c.photoPath, updated_at: new Date().toISOString(),
      }));
    },
    async items() { return must(await sb.from('ledger_items').select('*').order('name')).map(fromItem); },
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
    outlets: [{ id: 'a', name: '档口 1' }],
    outlet: lsGet('ledger.outlet', 'a'),
    closings: [], items: [], moves: [],
    photoBlob: null, photoPath: null, photoUploading: null,
    photoUrls: {},
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
      $('loginMsg').innerHTML = `<div class="note bad">这个账号还没有开通。请联系老板把你的邮箱加进账本。</div>`;
      await sb.auth.signOut();
      return;
    }
    $('whoami').textContent = `已登录：${session.user.email}`;
    $('loginView').hidden = true; $('appView').hidden = false;
    if (!started) { started = true; await refreshAll(); }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginBtn'); btn.disabled = true; btn.textContent = '登录中…';
    $('loginMsg').innerHTML = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('loginEmail').value.trim(), password: $('loginPass').value });
    btn.disabled = false; btn.textContent = '登录';
    if (error) { $('loginMsg').innerHTML = `<div class="note bad">邮箱或密码不对，请再试一次。</div>`; return; }
    await showForSession(data.session);
  });
  $('signOut').addEventListener('click', async () => { await sb.auth.signOut(); showForSession(null); });
  sb.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_OUT') showForSession(null); });
  sb.auth.getSession().then(({ data }) => showForSession(data.session));

  // ── loading / refresh ──────────────────────────────────────────────────
  let refreshing = null;
  async function refreshAll() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const [settings, closings, items, moves] = await Promise.all([api.settings(), api.closings(), api.items(), api.moves()]);
        if (Array.isArray(settings?.outlets) && settings.outlets.length) S.outlets = settings.outlets.map(o => ({ id: String(o.id), name: String(o.name) }));
        S.closings = closings; S.items = items; S.moves = moves;
        renderOutlets(); renderClose(); renderStock();
        if (!$('tab-report').hidden) loadReport();
        $('statusNote').innerHTML = '';
      } catch (e) {
        console.error(e);
        $('statusNote').innerHTML = `<div class="note warn">连不上网络，显示的可能不是最新的。有网时会自动更新。</div>`;
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

  // ── outlets ────────────────────────────────────────────────────────────
  const outletName = (id) => S.outlets.find(o => o.id === id)?.name || id;
  function renderOutlets() {
    if (!S.outlets.some(o => o.id === S.outlet)) S.outlet = S.outlets[0]?.id;
    const multi = S.outlets.length > 1;
    $('outletSeg').hidden = !multi;
    $('reportScope').hidden = !multi;
    if (!multi) S.reportScope = 'all';
    $('outletSeg').innerHTML = S.outlets.map(o =>
      `<button data-id="${esc(o.id)}" aria-pressed="${o.id === S.outlet}">${esc(o.name)}</button>`).join('');
    $('reportScope').innerHTML = [{ id: 'all', name: '全部档口' }, ...S.outlets].map(o =>
      `<button data-id="${esc(o.id)}" aria-pressed="${o.id === S.reportScope}">${esc(o.name)}</button>`).join('');
    $('outletEdit').innerHTML = S.outlets.map((o, i) =>
      `<label class="f">档口 ${i + 1}<input id="outlet-name-${esc(o.id)}" data-id="${esc(o.id)}" value="${esc(o.name)}" maxlength="30"></label>`).join('');
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
    if (total == null && sum === 0) { el.innerHTML = ''; return; }
    if (sum === 0) { el.innerHTML = `<div class="muted">付款方式可以不填，只填总额也行。</div>`; return; }
    const diff = (total || 0) - sum;
    el.innerHTML = Math.abs(diff) < 1
      ? `<div class="sumline"><span class="muted">付款加起来</span><span class="num" style="color:var(--good)">${money(sum)} ✓ 对得上</span></div>`
      : `<div class="note warn">付款加起来是 <b class="num">${money(sum)}</b>，跟总额差 <b class="num">${money(Math.abs(diff))}</b>，再对一下。</div>`;
  }
  Object.values(F).forEach(inp => inp.addEventListener('input', checkSum));

  function fillForm(c) {
    F.total.value = fixed(c?.total); F.orders.value = c?.orders ?? '';
    for (const [k] of PAY) F[k].value = fixed(c?.pay?.[k]);
    F.note.value = c?.note || '';
    checkSum();
  }

  function renderClose() {
    const ex = existingClose();
    $('overwriteNote').innerHTML = ex
      ? `<div class="note info">${esc(outletName(S.outlet))} ${fmtDay($('closeDate').value)} 已经记过（${money(ex.total)}）。再保存会更新这一笔。</div>`
      : '';
    $('saveClose').textContent = ex ? '更新这一天的账' : '保存这一天的账';
    renderRecent();
  }
  $('closeDate').addEventListener('change', () => { const ex = existingClose(); if (ex) fillForm(ex); renderClose(); });

  async function renderRecent() {
    const rows = S.closings.filter(c => c.outletId === S.outlet).slice(0, 14);
    if (!rows.length) {
      $('recentClosings').innerHTML = `<div class="empty">还没有 ${esc(outletName(S.outlet))} 的记录。收档后拍日结单，第一笔就会出现在这里。</div>`;
      return;
    }
    const need = rows.map(r => r.photoPath).filter(p => p && !S.photoUrls[p]);
    if (need.length) { try { Object.assign(S.photoUrls, await api.photoUrls(need)); } catch {} }
    $('recentClosings').innerHTML = rows.map(c => `
      <div class="it clickable" data-id="${esc(c.id)}">
        ${c.photoPath && S.photoUrls[c.photoPath] ? `<a href="${esc(S.photoUrls[c.photoPath])}" target="_blank" rel="noopener" data-photo><img class="thumb" src="${esc(S.photoUrls[c.photoPath])}" alt="日结单照片" loading="lazy"></a>` : `<span class="thumb"></span>`}
        <div class="main">
          <div class="title">${fmtDay(c.date)}</div>
          <div class="muted">${c.orders ? c.orders + ' 单 · ' : ''}${PAY.filter(([k]) => c.pay?.[k]).map(([k, n]) => n + ' ' + fixed(c.pay[k])).join(' · ') || '只记总额'}</div>
        </div>
        <div class="amt">${money(c.total)}</div>
      </div>`).join('');
  }
  $('recentClosings').addEventListener('click', e => {
    if (e.target.closest('[data-photo]')) return; // open the photo instead
    const it = e.target.closest('.it'); if (!it) return;
    const c = S.closings.find(x => x.id === it.dataset.id); if (!c) return;
    $('closeDate').value = c.date; fillForm(c); renderClose(); window.scrollTo(0, 0);
    toast('已载入，可以修改后再保存');
  });

  // Photo → shrink → upload + read text on the phone
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('无法读取这张照片'));
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
    $('photoHint').textContent = '换一张照片';
    try {
      const img = await loadImage(file);
      const blob = await toJpeg(drawScaled(img, 1600));
      S.photoBlob = blob;
      S.photoUploading = api.uploadPhoto(blob, closeId()).then(p => (S.photoPath = p)).catch(() => (S.photoPath = null));
      readReceipt(drawScaled(img, 2200));
    } catch (e) {
      $('aiNote').innerHTML = `<div class="note warn">${esc(e.message)}，请照着单子手动填。</div>`;
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
    note(`<div class="note info"><span class="spin"></span> 正在读日结单…第一次要下载识别文件，会慢一点。</div>`);
    try {
      await loadTesseract();
      const worker = await window.Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') note(`<div class="note info"><span class="spin"></span> 正在读日结单… ${Math.round(m.progress * 100)}%</div>`);
        },
      });
      const { data } = await worker.recognize(prepForOcr(canvas));
      await worker.terminate();
      if (run !== ocrRun) return;
      const r = window.LedgerOCR.parseReport(data.text);
      const found = [];
      if (r.total != null) { F.total.value = fixed(r.total); found.push('总额'); }
      for (const [k, n] of PAY) if (r.pay[k]) { F[k].value = fixed(r.pay[k]); found.push(n); }
      if (r.orders != null) { F.orders.value = r.orders; found.push('单数'); }
      checkSum();
      const raw = `<details><summary class="muted">看识别出来的文字</summary><div class="ocr-raw">${esc(data.text.trim())}</div></details>`;
      if (!found.length) {
        note(`<div class="note warn">照片读到了，但找不到金额。请照着单子手动填。拍的时候放平、光线亮一点会更准。</div>${raw}`);
      } else if (r.date && r.date !== $('closeDate').value) {
        note(`<div class="note warn">已填入：${found.join('、')}。单上的日期是 <b>${esc(r.date)}</b>，跟选的日期不一样。<button class="btn small" id="useOcrDate" type="button">改成 ${esc(r.date)}</button></div>${raw}`);
        $('useOcrDate').onclick = () => { $('closeDate').value = r.date; renderClose(); toast('日期已改'); };
      } else {
        note(`<div class="note info">已填入：${found.join('、')}。<b>请对着单子检查一遍</b>再保存。</div>${raw}`);
      }
    } catch (e) {
      console.error(e);
      note(`<div class="note warn">读不了这张单（可能没有网络），请手动填。照片仍会保存。</div>`);
    }
  }

  $('saveClose').addEventListener('click', async () => {
    const date = $('closeDate').value;
    const total = toCents(F.total.value);
    if (!date) return toast('请选日期');
    if (total == null || total < 0) { F.total.focus(); return toast('请填总营业额'); }
    const btn = $('saveClose'); btn.disabled = true; btn.textContent = '保存中…';
    try {
      if (S.photoUploading) await S.photoUploading;
      const prev = existingClose();
      const pay = {};
      for (const [k] of PAY) { const v = toCents(F[k].value); if (v) pay[k] = v; }
      const orders = parseInt(F.orders.value, 10);
      await api.saveClosing({
        id: closeId(), date, outletId: S.outlet, total, pay,
        orders: Number.isFinite(orders) ? orders : null,
        note: F.note.value.trim().slice(0, 200),
        photoPath: S.photoPath || prev?.photoPath || null,
      });
      toast(`${outletName(S.outlet)} ${fmtDay(date)} 已保存：${money(total)}`);
      S.photoBlob = null; S.photoPath = null; S.photoUploading = null; ocrRun++;
      $('photoPrev').hidden = true; $('aiNote').innerHTML = ''; $('photoHint').textContent = '拍 POS 打印的日结单，手机会自动读出数字';
      fillForm(null);
      await refreshAll();
    } catch (e) {
      console.error(e); toast('保存失败，请检查网络再试一次');
    } finally {
      btn.disabled = false; renderClose();
    }
  });

  // ── stock ──────────────────────────────────────────────────────────────
  const qtyOf = (it, outletId = S.outlet) => Number(it.qty?.[outletId] || 0);
  const levelOf = (it) => {
    const q = qtyOf(it);
    if (q <= 0) return 'out';
    if (it.low != null && q <= it.low) return 'low';
    return 'ok';
  };
  const LV_ORDER = { out: 0, low: 1, ok: 2 };

  function renderStock() {
    const term = $('stockSearch').value.trim().toLowerCase();
    const items = S.items.filter(i => i.active !== false && (!term || i.name.toLowerCase().includes(term)))
      .sort((a, b) => (LV_ORDER[levelOf(a)] - LV_ORDER[levelOf(b)]) || a.name.localeCompare(b.name, 'zh'));
    const lows = S.items.filter(i => i.active !== false && levelOf(i) !== 'ok');
    $('lowSummary').innerHTML = lows.length
      ? `<div class="note warn"><b>要补货：</b>${lows.map(i => esc(i.name)).join('、')}</div>`
      : (S.items.length ? `<div class="note info">库存都够。</div>` : '');
    $('stockList').innerHTML = items.length ? items.map(i => {
      const lv = levelOf(i);
      return `<div class="it clickable" data-id="${esc(i.id)}">
        <div class="main"><div class="title">${esc(i.name)}</div>
          <div class="muted">${i.category ? esc(i.category) + ' · ' : ''}${i.low != null ? `少于 ${qtyFmt(i.low)} ${esc(i.unit)} 提醒` : '没设提醒'}</div></div>
        <span class="pill ${lv}">${lv === 'out' ? '没货' : lv === 'low' ? '快没了' : '够'}</span>
        <div class="amt">${qtyFmt(qtyOf(i))} ${esc(i.unit)}</div>
      </div>`;
    }).join('') : `<div class="empty">${S.items.length ? '找不到这个货品。' : '还没有货品。点「＋ 新货品」加鸡扒、薯条、意面这些主要食材。'}</div>`;

    const moves = S.moves.filter(m => m.outletId === S.outlet).slice(0, 20);
    $('moveList').innerHTML = moves.length ? moves.map(m => `
      <div class="it">
        <span class="pill ${m.type === 'in' ? 'ok' : m.type === 'waste' ? 'out' : ''}">${MOVE_TYPES[m.type] || m.type}</span>
        <div class="main"><div class="title">${esc(m.itemName)}</div>
          <div class="muted">${fmtDay(m.date)}${m.supplier ? ' · ' + esc(m.supplier) : ''}${m.note ? ' · ' + esc(m.note) : ''}</div></div>
        <div class="amt">${m.type === 'count' ? '剩 ' + qtyFmt(m.after) : (m.type === 'in' ? '+' : '−') + qtyFmt(m.qty)} ${esc(m.unit)}${m.cost ? '<div class="muted">' + money(m.cost) + '</div>' : ''}</div>
      </div>`).join('') : `<div class="empty">进货、盘点、报废的记录会出现在这里。</div>`;
  }
  $('stockSearch').addEventListener('input', renderStock);

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
      <button class="btn small x" data-close type="button">关闭</button>
      <h2>${item ? '修改货品' : '新货品'}</h2>
      <label class="f">名称<input id="it-name" maxlength="40" placeholder="例如：鸡扒" value="${esc(item?.name || '')}"></label>
      <div class="fields">
        <label class="f">单位<input id="it-unit" maxlength="10" placeholder="块 / 包 / kg" value="${esc(item?.unit || '')}"></label>
        <label class="f">少于多少提醒<input id="it-low" class="money" inputmode="decimal" placeholder="10" value="${item?.low ?? ''}"></label>
      </div>
      <label class="f">类别（可不填）<input id="it-cat" maxlength="20" placeholder="肉类 / 冷冻 / 酱料 / 包装" value="${esc(item?.category || '')}"></label>
      ${item ? '' : `<label class="f">现在有多少<input id="it-qty" class="money" inputmode="decimal" placeholder="0"></label>`}
      <button class="btn primary block" id="it-save" type="button">保存</button>
      ${item ? `<button class="btn block danger" id="it-hide" type="button">不再使用这个货品</button>` : ''}
    `, (el, close) => {
      el.querySelector('#it-name').focus();
      el.querySelector('#it-save').onclick = async () => {
        const name = el.querySelector('#it-name').value.trim();
        const unit = el.querySelector('#it-unit').value.trim() || '个';
        const low = parseFloat(el.querySelector('#it-low').value);
        const category = el.querySelector('#it-cat').value.trim() || null;
        if (!name) return toast('请填名称');
        try {
          if (item) await api.updateItem(item.id, { name, unit, low: Number.isFinite(low) ? low : null, category });
          else {
            const q = parseFloat(el.querySelector('#it-qty').value);
            await api.addItem({ name, unit, low: Number.isFinite(low) ? low : null, category, qty: Number.isFinite(q) ? { [S.outlet]: q } : {} });
          }
          close(); toast('已保存'); refreshAll();
        } catch (e) { console.error(e); toast('保存失败'); }
      };
      const hide = el.querySelector('#it-hide');
      if (hide) hide.onclick = async () => {
        if (hide.dataset.armed !== '1') { hide.dataset.armed = '1'; hide.textContent = '再按一次确认（以前的记录会保留）'; return; }
        try { await api.updateItem(item.id, { active: false }); close(); toast('已隐藏'); refreshAll(); } catch { toast('失败'); }
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
    openSheet(`
      <div class="row"><h2 class="grow">${esc(item.name)}</h2><button class="btn small" data-close type="button">关闭</button></div>
      <div class="muted">现在：<b class="num">${qtyFmt(qtyOf(item))} ${esc(item.unit)}</b></div>
      <div class="typegrid" id="mv-types">
        <button class="btn" data-t="in" aria-pressed="true" type="button">进货</button>
        <button class="btn" data-t="count" aria-pressed="false" type="button">盘点</button>
        <button class="btn" data-t="waste" aria-pressed="false" type="button">报废</button>
      </div>
      <label class="f"><span id="mv-qty-t">进了多少（${esc(item.unit)}）</span><input id="mv-qty" class="money" inputmode="decimal" placeholder="0"></label>
      <div class="fields" id="mv-in-fields">
        <label class="f">总价 S$<input id="mv-cost" class="money" inputmode="decimal" placeholder="0.00"></label>
        <label class="f">供应商<input id="mv-sup" maxlength="40" placeholder="例如：Sheng Siong" list="sup-list"></label>
      </div>
      <datalist id="sup-list">${suppliers.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <label class="f">日期<input id="mv-date" type="date" value="${localDate()}"></label>
      <label class="f">备注（可不填）<input id="mv-note" maxlength="80"></label>
      <div id="mv-preview" class="muted"></div>
      <button class="btn primary block" id="mv-save" type="button">记录进货</button>
      <button class="btn block" id="mv-edit" type="button">修改货品资料</button>
    `, (el, close) => {
      const qInp = el.querySelector('#mv-qty');
      const preview = () => {
        const q = parseFloat(qInp.value); const cur = qtyOf(item);
        if (!Number.isFinite(q)) { el.querySelector('#mv-preview').textContent = ''; return; }
        const after = type === 'in' ? cur + q : type === 'waste' ? cur - q : q;
        const extra = type === 'count' ? `（${after <= cur ? '用掉' : '多出'} ${qtyFmt(Math.abs(cur - after))} ${item.unit}）` : '';
        el.querySelector('#mv-preview').textContent = `保存后：${qtyFmt(after)} ${item.unit}${extra}`;
      };
      qInp.addEventListener('input', preview);
      el.querySelector('#mv-types').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        type = b.dataset.t;
        el.querySelectorAll('#mv-types button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        el.querySelector('#mv-in-fields').hidden = type !== 'in';
        el.querySelector('#mv-qty-t').textContent = { in: `进了多少（${item.unit}）`, count: `实际还剩多少（${item.unit}）`, waste: `报废多少（${item.unit}）` }[type];
        el.querySelector('#mv-save').textContent = { in: '记录进货', count: '记录盘点', waste: '记录报废' }[type];
        preview();
      };
      el.querySelector('#mv-edit').onclick = () => editItem(item);
      el.querySelector('#mv-save').onclick = async () => {
        const q = parseFloat(qInp.value);
        if (!Number.isFinite(q) || q < 0 || (type !== 'count' && q === 0)) { qInp.focus(); return toast('请填数量'); }
        const btn = el.querySelector('#mv-save'); btn.disabled = true;
        try {
          const mv = await api.recordMove({
            itemId: item.id, outletId: S.outlet, type, qty: q,
            cost: type === 'in' ? (toCents(el.querySelector('#mv-cost').value) || 0) : 0,
            supplier: type === 'in' ? el.querySelector('#mv-sup').value.trim() : '',
            note: el.querySelector('#mv-note').value.trim(),
            date: el.querySelector('#mv-date').value || localDate(),
          });
          close(); toast(`${item.name}：${MOVE_TYPES[type]}已记录，现在 ${qtyFmt(mv.after)} ${item.unit}`);
          refreshAll();
        } catch (e) { console.error(e); btn.disabled = false; toast('记录失败，请再试'); }
      };
    });
  }

  // ── monthly report (profit & loss) ─────────────────────────────────────
  const EXPENSES = [
    ['rent', '租金'], ['wages', '人工 / CPF'], ['utilities', '水电'], ['gas', '煤气'],
    ['commission', '外卖平台佣金'], ['misc', '清洁 / 杂费'],
  ];
  function monthRange(m) {
    const [y, mo] = m.split('-').map(Number);
    const dim = new Date(y, mo, 0).getDate();
    return { start: `${m}-01`, end: `${m}-${pad(dim)}`, y, mo, dim };
  }
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
  const scopeOutlets = () => S.reportScope === 'all' ? S.outlets.map(o => o.id) : [S.reportScope];
  const scopeLabel = () => S.reportScope === 'all' ? (S.outlets.length > 1 ? '全部档口' : outletName(S.outlets[0]?.id)) : outletName(S.reportScope);

  async function fetchMonth(m) {
    const outs = new Set(scopeOutlets());
    const d = await api.month(m);
    const pick = (rows) => rows.filter(x => outs.has(x.outletId));
    return { closings: pick(d.closings), moves: pick(d.moves), expenses: pick(d.expenses) };
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
    $('reportBody').innerHTML = `<div class="empty"><span class="spin"></span> 计算中…</div>`;
    try {
      const [cur, prev] = await Promise.all([fetchMonth(month), fetchMonth(prevMonth(month))]);
      if (seq !== reportSeq) return;
      lastReport = { month, data: cur, sum: summarize(cur), prev: summarize(prev) };
      renderReport();
    } catch (e) {
      console.error(e);
      if (seq === reportSeq) $('reportBody').innerHTML = `<div class="note bad">读取月报失败，请检查网络再试。</div>`;
    }
  }
  $('reportMonth').addEventListener('change', loadReport);

  function change(cur, prev) {
    if (!prev) return '';
    const d = Math.round((cur - prev) / Math.abs(prev) * 100);
    if (!Number.isFinite(d) || d === 0) return `<span class="chg">与上月持平</span>`;
    return `<span class="chg ${d > 0 ? 'up' : 'down'}">比上月 ${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
  }

  function renderReport() {
    const { month, data, sum, prev } = lastReport;
    const { y, mo, dim } = monthRange(month);
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
        note: cs.map(c => c.note).filter(Boolean).join('；'),
      });
    }
    const maxDay = Math.max(1, ...dayRows.map(r => r.total));
    const byWeekday = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    for (const r of dayRows) { const w = new Date(r.date + 'T00:00:00').getDay(); byWeekday[w].sum += r.total; byWeekday[w].n++; }
    const wkTop = Math.max(1, ...byWeekday.map(x => x.n ? x.sum / x.n : 0));
    const payTotals = PAY.map(([k, n]) => [k, n, data.closings.reduce((a, c) => a + (c.pay?.[k] || 0), 0)]).filter(([, , v]) => v > 0);
    const bySupplier = {}, byItem = {};
    for (const m of sum.buys) {
      const s = m.supplier || '未填供应商';
      bySupplier[s] = (bySupplier[s] || 0) + (m.cost || 0);
      byItem[m.itemName] = (byItem[m.itemName] || 0) + (m.cost || 0);
    }
    const wastes = data.moves.filter(m => m.type === 'waste');
    const sortDesc = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    const editable = S.reportScope !== 'all' || S.outlets.length === 1;
    const expBtn = editable
      ? `<button class="btn" id="editExp" type="button">${sum.opex ? '修改这个月的开支' : '填写这个月的开支（租金、人工、水电…）'}</button>`
      : `<div class="muted">要填开支，请先在上面选一个档口。</div>`;

    $('exportBtn').hidden = false;
    if (!data.closings.length && !data.moves.length && !sum.opex) {
      $('reportBody').innerHTML = `<div class="empty">${y}年${mo}月还没有记录。每天收档记账，这里会自动算出营业额、成本和利润。</div>${editable ? expBtn : ''}`;
      $('exportBtn').hidden = true;
      $('editExp')?.addEventListener('click', editExpenses);
      return;
    }

    const line = (label, v, cls = '', extra = '') =>
      `<div class="pl-row ${cls}"><span>${label}${extra}</span><span class="num">${v < 0 ? '−' : ''}${money(Math.abs(v))}</span></div>`;

    $('reportBody').innerHTML = `
      <div class="card">
        <h3>损益表 · ${y}年${mo}月 · ${esc(scopeLabel())}</h3>
        <div class="pl">
          ${line('营业额', sum.sales, 'head', change(sum.sales, prev.sales))}
          ${line('减：食材进货', -sum.cogs, 'sub', sum.sales ? ` <span class="muted">（${pct(sum.cogs, sum.sales)}%）</span>` : '')}
          ${line('毛利', sum.gross, 'total', sum.sales ? ` <span class="muted">毛利率 ${pct(sum.gross, sum.sales)}%</span>` : '')}
          ${EXPENSES.filter(([k]) => sum.exp[k]).map(([k, n]) => line('减：' + n, -sum.exp[k], 'sub')).join('')}
          ${sum.opex ? '' : `<div class="pl-row sub"><span class="muted">还没填这个月的开支</span><span></span></div>`}
          ${line('净利', sum.net, 'net ' + (sum.net < 0 ? 'neg' : ''), change(sum.net, prev.net))}
        </div>
        ${expBtn}
        <div class="muted">食材成本按这个月记录的进货计算。月初、月底库存差别大时，利润会有偏差。</div>
      </div>

      <div class="kpis">
        <div class="kpi"><div class="k">营业天数</div><div class="v">${sum.days}<span class="unit"> / ${elapsed} 天</span></div>
          <div class="s">${missing.length ? `${missing.length} 天没记录` : '每天都有记录'}</div></div>
        <div class="kpi"><div class="k">日均营业额</div><div class="v">${money(sum.days ? Math.round(sum.sales / sum.days) : 0)}</div>
          <div class="s">${change(sum.days ? sum.sales / sum.days : 0, prev.days ? prev.sales / prev.days : 0)}</div></div>
        <div class="kpi"><div class="k">单数</div><div class="v">${sum.orders || '—'}</div>
          <div class="s">${sum.orders ? '平均每单 ' + money(Math.round(sum.sales / sum.orders)) : '日结单没有单数'}</div></div>
        <div class="kpi"><div class="k">报废</div><div class="v">${wastes.length}<span class="unit"> 次</span></div>
          <div class="s">${wastes.length ? wastes.slice(0, 3).map(w => esc(w.itemName)).join('、') : '没有报废'}</div></div>
      </div>

      ${missing.length && sum.days ? `<div class="note warn">这些日子没有记录：${missing.map(d => mo + '/' + d).join('、')}。休息日不用理；有开档的话记得补记。</div>` : ''}

      <div class="card">
        <h3>每日营业额</h3>
        <div class="daybars" role="img" aria-label="每日营业额柱状图">${Array.from({ length: dim }, (_, i) => {
          const r = dayRows.find(x => x.date === `${month}-${pad(i + 1)}`);
          return `<span class="${r ? '' : 'empty'}" style="height:${r ? Math.max(4, r.total / maxDay * 100) : 4}%" title="${i + 1}日 ${r ? money(r.total) : '没记录'}"></span>`;
        }).join('')}</div>
        <div class="axis"><span>1</span><span>${Math.ceil(dim / 2)}</span><span>${dim}</span></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>日期</th><th class="r">营业额</th><th class="r">单数</th><th class="r">平均每单</th></tr></thead>
          <tbody>${dayRows.map(r => `<tr><td>${fmtDay(r.date)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td>
            <td class="r num">${fixed(r.total)}</td><td class="r num">${r.orders || ''}</td>
            <td class="r num">${r.orders ? fixed(Math.round(r.total / r.orders)) : ''}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>合计</td><td class="r num">${fixed(sum.sales)}</td><td class="r num">${sum.orders || ''}</td><td></td></tr></tfoot>
        </table></div>
      </div>

      ${dayRows.length >= 7 ? `<div class="card"><h3>星期几生意最好</h3>
        ${[1, 2, 3, 4, 5, 6, 0].map(w => {
          const b = byWeekday[w]; const avg = b.n ? Math.round(b.sum / b.n) : 0;
          return `<div class="wk"><span>周${'日一二三四五六'[w]}</span><div class="bar"><span style="width:${avg / wkTop * 100}%"></span></div><span class="num">${b.n ? fixed(avg) : '—'}</span></div>`;
        }).join('')}<div class="muted">按有记录的日子算平均。</div></div>` : ''}

      ${payTotals.length ? `<div class="card"><h3>付款方式</h3><div class="tbl-wrap"><table class="tbl"><tbody>
        ${payTotals.map(([, n, v]) => `<tr><td>${n}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${pct(v, sum.sales)}%</td></tr>`).join('')}
        </tbody></table></div>
        ${payTotals.some(([k]) => k === 'cash') ? `<div class="muted">现金 ${money(payTotals.find(([k]) => k === 'cash')[2])} 应该跟这个月存进银行的现金对得上。</div>` : ''}</div>` : ''}

      ${sum.buys.length ? `<div class="card"><h3>进货</h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>供应商</th><th class="r">金额</th><th class="r">占比</th></tr></thead><tbody>
          ${sortDesc(bySupplier).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${pct(v, sum.cogs)}%</td></tr>`).join('')}
        </tbody></table></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>货品</th><th class="r">金额</th><th class="r">占营业额</th></tr></thead><tbody>
          ${sortDesc(byItem).slice(0, 10).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r num">${fixed(v)}</td><td class="r num muted">${sum.sales ? pct(v, sum.sales) + '%' : ''}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
    `;
    $('editExp')?.addEventListener('click', editExpenses);
  }

  function editExpenses() {
    const month = lastReport?.month || $('reportMonth').value;
    const outletId = S.reportScope === 'all' ? S.outlets[0].id : S.reportScope;
    const existing = lastReport?.data.expenses.find(e => e.outletId === outletId);
    const { y, mo } = monthRange(month);
    openSheet(`
      <div class="row"><h2 class="grow">${y}年${mo}月 开支</h2><button class="btn small" data-close type="button">关闭</button></div>
      <div class="muted">${esc(outletName(outletId))} · 填这个月实际付的钱，没有的留空。</div>
      <div class="fields">${EXPENSES.map(([k, n]) =>
        `<label class="f">${n} S$<input class="money" id="exp-${k}" inputmode="decimal" placeholder="0.00" value="${fixed(existing?.lines?.[k] || null)}"></label>`).join('')}</div>
      <label class="f">备注<input id="exp-note" maxlength="120" placeholder="例如：人工包括 2 个帮手" value="${esc(existing?.note || '')}"></label>
      <button class="btn primary block" id="exp-save" type="button">保存开支</button>
      <button class="btn block" id="exp-copy" type="button">照上个月的开支填</button>
    `, (el, close) => {
      el.querySelector('#exp-copy').onclick = async () => {
        try {
          const prev = await api.expense(`${prevMonth(month)}_${outletId}`);
          if (!prev) return toast('上个月没有填开支');
          for (const [k] of EXPENSES) el.querySelector('#exp-' + k).value = fixed(prev.lines[k] || null);
          toast('已填入上个月的数字，记得检查');
        } catch { toast('读取失败'); }
      };
      el.querySelector('#exp-save').onclick = async () => {
        const lines = {};
        for (const [k] of EXPENSES) { const v = toCents(el.querySelector('#exp-' + k).value); if (v) lines[k] = v; }
        try {
          await api.saveExpense({ id: `${month}_${outletId}`, month, outletId, lines, note: el.querySelector('#exp-note').value.trim() });
          close(); toast('开支已保存'); loadReport();
        } catch (e) { console.error(e); toast('保存失败'); }
      };
    });
  }

  $('exportBtn').addEventListener('click', () => {
    if (!lastReport) return;
    const { month, data, sum } = lastReport;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row = (...cells) => cells.map(q).join(',');
    const L = [row(`月报 ${month}`, scopeLabel())];
    L.push('', row('损益表', '金额 (S$)'));
    L.push(row('营业额', fixed(sum.sales)), row('食材进货', fixed(sum.cogs)), row('毛利', fixed(sum.gross)));
    for (const [k, n] of EXPENSES) if (sum.exp[k]) L.push(row(n, fixed(sum.exp[k])));
    L.push(row('开支合计', fixed(sum.opex)), row('净利', fixed(sum.net)));
    L.push('', row('日期', '档口', '营业额', ...PAY.map(([, n]) => n), '单数', '备注'));
    for (const c of [...data.closings].sort((a, b) => a.date.localeCompare(b.date)))
      L.push(row(c.date, outletName(c.outletId), fixed(c.total), ...PAY.map(([k]) => fixed(c.pay?.[k])), c.orders ?? '', c.note));
    L.push('', row('日期', '档口', '类型', '货品', '数量', '金额', '供应商', '备注'));
    for (const m of [...data.moves].sort((a, b) => a.date.localeCompare(b.date)))
      L.push(row(m.date, outletName(m.outletId), MOVE_TYPES[m.type], m.itemName, `${qtyFmt(m.type === 'count' ? m.after : m.qty)} ${m.unit}`, m.cost ? fixed(m.cost) : '', m.supplier, m.note));
    const blob = new Blob(['﻿' + L.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `月报-${month}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ── settings ───────────────────────────────────────────────────────────
  $('addOutlet').addEventListener('click', () => {
    S.outlets.push({ id: 'o' + Date.now().toString(36), name: `档口 ${S.outlets.length + 1}` });
    renderOutlets();
    toast('加好了，改名字后按「保存名称」');
  });
  $('saveOutlets').addEventListener('click', async () => {
    document.querySelectorAll('#outletEdit input').forEach(inp => {
      const o = S.outlets.find(x => x.id === inp.dataset.id);
      if (o) o.name = inp.value.trim() || o.name;
    });
    try { await api.saveSettings({ outlets: S.outlets }); toast('档口已保存'); } catch { toast('保存失败'); }
    renderOutlets(); renderClose(); renderStock();
  });

  // ── offline shell ──────────────────────────────────────────────────────
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
