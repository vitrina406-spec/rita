(() => {
  'use strict';

  /* ---------- Telegram WebApp ---------- */
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
  const cs = tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
  const COLORS = { light: { bg: '#fff5f8', card: '#ffffff' }, dark: { bg: '#1d1418', card: '#2a1c23' } };

  // Палитра розовая, а светлый/тёмный вариант берём из темы Telegram
  function applyTheme() {
    const scheme = (tg && tg.colorScheme) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', scheme === 'dark' ? 'dark' : 'light');
    const c = COLORS[scheme === 'dark' ? 'dark' : 'light'];
    if (!tg) return;
    try {
      tg.setHeaderColor(c.bg);
      tg.setBackgroundColor(c.bg);
      if (tg.setBottomBarColor) tg.setBottomBarColor(c.card);
    } catch (e) { /* старые версии клиента */ }
  }
  applyTheme();
  if (tg) {
    tg.ready();
    tg.expand();
    tg.onEvent('themeChanged', applyTheme);
    tg.BackButton.onClick(() => closeSheet());
  }

  /* ---------- helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => dateStr(new Date());
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
  const fmtDate = (s) => { if (!s) return 'без даты'; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
  const fmtLong = (s) => parseDate(s).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
  const sum = (arr, key) => arr.reduce((a, x) => a + (Number(x[key]) || 0), 0);
  const fmtAmt = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  const settings = { currency: '₴', pricePerKg: 0 };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('cake-settings') || '{}')); } catch (e) { /* ignore */ }
  const saveSettings = () => { try { localStorage.setItem('cake-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } scheduleCloud(); };

  const money = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n) || 0) + ' ' + esc(settings.currency);
  const kg = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n) || 0) + ' кг';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const haptic = (kind = 'success') => { try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(kind); } catch (e) { /* ignore */ } };
  const ask = (msg) => new Promise((res) => {
    if (tg && tg.showConfirm) tg.showConfirm(msg, (ok) => res(!!ok));
    else res(window.confirm(msg));
  });

  /* ---------- IndexedDB ---------- */
  const STORES = ['orders', 'recipes', 'expenses'];
  let db;
  const openDB = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('cake-miniapp', 1);
    r.onupgradeneeded = () => STORES.forEach((s) => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = (store, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const dbAll = (s) => tx(s, 'readonly', (st) => st.getAll());
  const dbPut = (s, v) => tx(s, 'readwrite', (st) => st.put(v)).then((r) => { scheduleCloud(); return r; });
  const dbDel = (s, id) => tx(s, 'readwrite', (st) => st.delete(id)).then((r) => { scheduleCloud(); return r; });

  /* ---------- constants & state ---------- */
  const STATUS = {
    new: ['Новый', 'st-new'], work: ['В работе', 'st-work'], ready: ['Готов', 'st-ready'],
    done: ['Выдан', 'st-done'], cancel: ['Отменён', 'st-cancel'],
  };
  const ACTIVE = ['new', 'work', 'ready'];
  const KINDS = { recipe: 'Рецепт', tech: 'Техкарта' };
  const DEFAULT_CATS = ['Торты', 'Коржи', 'Кремы', 'Начинки', 'Декор', 'Другое'];
  const UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'ч.л.', 'ст.л.'];
  const EXP_CATS = ['Продукты', 'Упаковка', 'Доставка', 'Инструменты', 'Другое'];

  let orders = [], recipes = [], expenses = [];
  const state = {
    tab: 'home', orderFilter: 'active', q: '', recipeCat: 'all', rq: '',
    month: todayStr().slice(0, 7),
  };
  let draftFiles = [];
  let draftIngs = [];

  const orderDate = (o) => o.date || (o.createdAt || '').slice(0, 10) || todayStr();
  const debtOf = (o) => Math.max(0, (Number(o.price) || 0) - (Number(o.paid) || 0));
  const byDate = (a, b) => (orderDate(a) + (a.time || '99')).localeCompare(orderDate(b) + (b.time || '99'));

  /* ---------- files ---------- */
  const urlCache = new WeakMap();
  const urlOf = (blob) => { if (!urlCache.has(blob)) urlCache.set(blob, URL.createObjectURL(blob)); return urlCache.get(blob); };
  const isImg = (f) => (f.type || '').startsWith('image/');

  async function shrink(file) {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (e) { /* оставляем оригинал */ }
    return file;
  }

  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
  const isText = (f) => (f.type || '').startsWith('text/') || /\.txt$/i.test(f.name || '');

  function attachHTML(files, editable, ref) {
    if (!files.length) return '';
    ref = ref || { kind: '', id: '' };
    return `<div class="attach">${files.map((f, i) => {
      const rm = editable ? `<button type="button" class="rm" data-act="rm-file" data-i="${i}" aria-label="Убрать">✕</button>` : '';
      if (isImg(f)) return `<div class="att"><img src="${urlOf(f.blob)}" alt="${esc(f.name)}" data-act="view-img">${rm}</div>`;
      const icon = isPdf(f) ? '📕' : '📄';
      if (editable) return `<div class="att file"><span>${icon}</span>${esc(f.name)}${rm}</div>`;
      return `<button type="button" class="att file" data-act="open-file" data-ref="${esc(ref.kind)}:${esc(ref.id)}" data-i="${i}"><span>${icon}</span>${esc(f.name)}<small>Открыть</small></button>`;
    }).join('')}</div>`;
  }
  const refreshAttach = () => { const el = $('#attach'); if (el) el.innerHTML = attachHTML(draftFiles, true); };

  /* ---------- просмотр файлов внутри приложения ---------- */
  function openViewer(title, levels, apply) {
    const el = document.createElement('div');
    el.className = 'viewer2';
    el.innerHTML = `<div class="vbar"><b class="vtitle">${esc(title)}</b>${levels > 1 ? '<button data-act="vz" data-d="-1" aria-label="Уменьшить">−</button><button data-act="vz" data-d="1" aria-label="Увеличить">＋</button>' : ''}<button data-act="close" aria-label="Закрыть">✕</button></div><div class="vbody"></div>`;
    $('#sheet-root').appendChild(el);
    el._zi = 0; el._levels = levels; el._apply = apply || (() => {});
    sheetStack.push(el); syncBack();
    return el;
  }

  function openImage(src, name) {
    const ZOOM = [1, 1.6, 2.5, 4];
    const v = openViewer(name || 'Фото', ZOOM.length, (el) => { const im = $('img', el); if (im) im.style.width = (ZOOM[el._zi] * 100) + '%'; });
    $('.vbody', v).innerHTML = `<img src="${src}" alt="">`;
  }

  let pdfjsPromise;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'vendor/pdf.min.js';
        sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; resolve(window.pdfjsLib); };
        sc.onerror = () => { pdfjsPromise = null; reject(new Error('pdfjs')); };
        document.head.appendChild(sc);
      });
    }
    return pdfjsPromise;
  }

  function renderPdf(v, zoom) {
    const body = $('.vbody', v), pdf = v._pdf;
    const token = (v._tok = (v._tok || 0) + 1);
    body.innerHTML = '';
    const width = Math.max(200, body.clientWidth - 16) * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const drawPage = async (holder) => {
      if (token !== v._tok) return;
      try {
        const page = await pdf.getPage(Number(holder.dataset.n));
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min((width / base.width) * dpr, 2400 / base.width) });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        c.style.width = Math.round(width) + 'px'; c.style.height = Math.round((width * base.height) / base.width) + 'px';
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        if (token !== v._tok) return;
        holder.style.minHeight = ''; holder.innerHTML = ''; holder.appendChild(c);
      } catch (e) { holder.textContent = 'Не удалось показать страницу'; }
    };
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); drawPage(en.target); } }), { root: body, rootMargin: '900px 0px' });
    for (let n = 1; n <= pdf.numPages; n++) {
      const h = document.createElement('div');
      h.className = 'pg'; h.dataset.n = n; h.style.width = Math.round(width) + 'px'; h.style.minHeight = Math.round(width * 1.3) + 'px';
      body.appendChild(h); io.observe(h);
    }
  }

  async function openPdf(file) {
    const ZOOM = [1, 1.5, 2];
    const v = openViewer(file.name, ZOOM.length, (el) => { if (el._pdf) renderPdf(el, ZOOM[el._zi]); });
    const body = $('.vbody', v);
    body.innerHTML = '<div class="vmsg">Открываю PDF…</div>';
    try {
      const lib = await loadPdfJs();
      v._pdf = await lib.getDocument({ data: await file.blob.arrayBuffer() }).promise;
      renderPdf(v, ZOOM[0]);
    } catch (e) { console.error(e); body.innerHTML = '<div class="vmsg">Не удалось открыть этот PDF 😔</div>'; }
  }

  async function openText(file) {
    const v = openViewer(file.name, 1);
    $('.vbody', v).innerHTML = `<pre class="vtext">${esc(await file.blob.text())}</pre>`;
  }

  async function openFile(f) {
    if (isImg(f)) return openImage(urlOf(f.blob), f.name);
    if (isPdf(f)) return openPdf(f);
    if (isText(f)) return openText(f);
    try {
      const file = new File([f.blob], f.name, { type: f.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    toast('Такой формат нельзя открыть внутри приложения. Загрузите рецепт как PDF или фото 🌸');
    return undefined;
  }

  /* ---------- sheets ---------- */
  const sheetStack = [];
  function syncBack() {
    if (!tg) return;
    if (sheetStack.length) tg.BackButton.show(); else tg.BackButton.hide();
  }
  function openSheet(html) {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`;
    el.addEventListener('click', (e) => { if (e.target === el) closeSheet(); });
    $('#sheet-root').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    sheetStack.push(el);
    syncBack();
    return el;
  }
  function closeSheet(instant) {
    const el = sheetStack.pop();
    if (!el) return;
    if (instant) el.remove();
    else { el.classList.remove('show'); setTimeout(() => el.remove(), 200); }
    syncBack();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  /* ---------- orders: cards & lists ---------- */
  function dueBadge(o) {
    if (!ACTIVE.includes(o.status)) return '';
    const d = orderDate(o), t = todayStr();
    if (d < t) return '<span class="late">просрочено</span>';
    if (d === t) return '<b>сегодня</b>';
    if (d === addDays(t, 1)) return 'завтра';
    return '';
  }

  function orderCard(o) {
    const [stName, stCls] = STATUS[o.status] || STATUS.new;
    const debt = debtOf(o);
    const d = parseDate(orderDate(o));
    const meta = [o.time ? `🕐 ${esc(o.time)}` : '', o.weight ? kg(o.weight) : '', o.delivery === 'delivery' ? '🚗 доставка' : '', o.filling ? esc(o.filling) : ''].filter(Boolean).join(' · ');
    return `<div class="card order" data-act="open-order" data-id="${o.id}">
      <div class="dbox"><b>${d.getDate()}</b><span>${MON_SHORT[d.getMonth()]}</span></div>
      <div class="obody">
        <div class="row"><div class="title">${esc(o.client) || 'Без имени'}</div><span class="chip ${stCls}">${stName}</span></div>
        ${meta ? `<div class="sub">${meta}</div>` : ''}
        <div class="row money"><b>${money(o.price)}</b>${debt > 0 ? `<span class="debt">осталось ${money(debt)}</span>` : (o.price > 0 ? '<span class="paid">оплачено ✓</span>' : '')}</div>
      </div></div>`;
  }

  function groupOf(o) {
    const d = orderDate(o), t = todayStr();
    if (d < t) return ['0', '⚠️ Просрочено'];
    if (d === t) return ['1', 'Сегодня'];
    if (d === addDays(t, 1)) return ['2', 'Завтра'];
    if (d <= addDays(t, 7)) return ['3', 'На этой неделе'];
    return ['4', 'Позже'];
  }

  function ordersListHTML() {
    const q = state.q.trim().toLowerCase();
    const list = orders.filter((o) => {
      const f = state.orderFilter;
      if (f === 'active' && !ACTIVE.includes(o.status)) return false;
      if (f === 'done' && o.status !== 'done') return false;
      if (f === 'debt' && !(debtOf(o) > 0 && o.status !== 'cancel')) return false;
      if (!q) return true;
      return [o.client, o.contact, o.design, o.filling, o.flavor, o.notes, o.inscription].some((x) => String(x || '').toLowerCase().includes(q));
    });
    if (!list.length) {
      return `<div class="empty"><div class="big">🎂</div>${orders.length ? 'Ничего не нашлось' : 'Пока нет заказов.<br>Нажмите «＋», чтобы добавить первый 🌸'}</div>`;
    }
    if (state.orderFilter === 'active') {
      list.sort(byDate);
      const groups = {};
      list.forEach((o) => { const [k, name] = groupOf(o); (groups[k] = groups[k] || { name, items: [] }).items.push(o); });
      return Object.keys(groups).sort().map((k) => `<h3>${groups[k].name} · ${groups[k].items.length}</h3>${groups[k].items.map(orderCard).join('')}`).join('');
    }
    list.sort((a, b) => -byDate(a, b));
    return list.map(orderCard).join('');
  }

  function renderOrders() {
    const f = state.orderFilter;
    const chip = (k, t) => `<button class="chip-btn ${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${t}</button>`;
    return `<input class="search" id="q" type="search" placeholder="🔍 Поиск: имя, начинка, дизайн…" value="${esc(state.q)}">
      <div class="chips">${chip('active', 'Активные')}${chip('debt', 'Не оплачены')}${chip('done', 'Выданные')}${chip('all', 'Все')}</div>
      <div id="list">${ordersListHTML()}</div>
      <button class="fab" data-act="add-order" aria-label="Новый заказ">＋</button>`;
  }

  /* ---------- orders: form ---------- */
  function orderFormHTML(o) {
    const isNew = !o;
    o = o || { date: todayStr(), status: 'new', delivery: 'pickup' };
    const statusOpts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v[0]}</option>`).join('');
    return `<form data-form="order" data-id="${esc(o.id || '')}">
      <h2>${isNew ? 'Новый заказ 🎂' : 'Редактировать заказ'}</h2>

      <div class="fsec">👤 Клиент</div>
      <label>Имя<input name="client" required value="${esc(o.client)}" placeholder="Как зовут"></label>
      <label>Телефон или @username<input name="contact" value="${esc(o.contact)}" placeholder="+380… или @name"></label>

      <div class="fsec">📅 Когда и как</div>
      <div class="grid2">
        <label>Дата<input type="date" name="date" required value="${esc(o.date)}"></label>
        <label>Время<input type="time" name="time" value="${esc(o.time)}"></label>
      </div>
      <label>Получение
        <select name="delivery"><option value="pickup" ${o.delivery !== 'delivery' ? 'selected' : ''}>Самовывоз</option><option value="delivery" ${o.delivery === 'delivery' ? 'selected' : ''}>Доставка</option></select>
      </label>
      <div id="addr-wrap" ${o.delivery === 'delivery' ? '' : 'hidden'}><label>Адрес доставки<input name="address" value="${esc(o.address)}" placeholder="Улица, дом, подъезд"></label></div>

      <div class="fsec">🎂 Торт</div>
      <div class="grid2">
        <label>Вес, кг<input name="weight" inputmode="decimal" value="${o.weight || ''}" placeholder="2,5"></label>
        <label>Порций<input name="servings" inputmode="numeric" value="${esc(o.servings)}" placeholder="16"></label>
      </div>
      <label>Бисквит / вкус<input name="flavor" value="${esc(o.flavor)}" placeholder="Ванильный, шоколадный…"></label>
      <label>Начинка<input name="filling" value="${esc(o.filling)}" placeholder="Клубника, крем-чиз…"></label>
      <label>Дизайн и пожелания<textarea name="design" rows="3" placeholder="Цвета, декор, стиль…">${esc(o.design)}</textarea></label>
      <div class="label">Фото-референсы</div>
      <div id="attach"></div>
      <label class="filebtn">📷 Добавить фото<input type="file" id="file" accept="image/*" multiple hidden></label>

      <div class="fsec">💰 Оплата</div>
      <div class="grid2">
        <label>Стоимость<input name="price" inputmode="decimal" value="${o.price || ''}" placeholder="0"></label>
        <label>Оплачено<input name="paid" inputmode="decimal" value="${o.paid || ''}" placeholder="предоплата"></label>
      </div>
      ${settings.pricePerKg > 0 ? `<button type="button" class="linkbtn" data-act="calc-price">✨ Посчитать по весу (${money(settings.pricePerKg)} за кг)</button>` : ''}

      <details class="more">
        <summary>＋ Ещё детали</summary>
        <label>Надпись на торте<input name="inscription" value="${esc(o.inscription)}" placeholder="С днём рождения, Аня!"></label>
        <label>Аллергии и ограничения<input name="allergies" value="${esc(o.allergies)}" placeholder="Без орехов, без лактозы…"></label>
        <label>Заметки<textarea name="notes" rows="2">${esc(o.notes)}</textarea></label>
        <label>Статус<select name="status">${statusOpts}</select></label>
      </details>

      <div class="actions"><button type="button" class="btn ghost" data-act="close">Отмена</button><button class="btn" type="submit">Сохранить</button></div>
    </form>`;
  }

  function openOrderForm(o) {
    draftFiles = o && o.files ? o.files.slice() : [];
    const el = openSheet(orderFormHTML(o));
    if (o && (o.inscription || o.allergies || o.notes || (o.status && o.status !== 'new'))) $('details.more', el).open = true;
    refreshAttach();
  }

  function contactActions(c) {
    if (!c) return '';
    const t = c.trim();
    if (/^@[\w\d_]{3,}$/.test(t)) return `<a class="btn small ghost" href="https://t.me/${esc(t.slice(1))}" target="_blank" rel="noopener">✈️ Написать</a>`;
    if (/^[+\d][\d\s()\-]{5,}$/.test(t)) return `<a class="btn small ghost" href="tel:${esc(t.replace(/[^\d+]/g, ''))}">📞 Позвонить</a>`;
    return '';
  }

  const lostHint = (x) => ((x.lostFiles || []).length ? `<div class="hint" style="margin-top:10px">📎 Файлы не сохранились в облаке: ${esc(x.lostFiles.join(', '))}. Загрузите их заново.</div>` : '');

  function openOrderDetail(id) {
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    const [stName, stCls] = STATUS[o.status] || STATUS.new;
    const debt = debtOf(o);
    const pct = o.price > 0 ? Math.min(100, Math.round((o.paid / o.price) * 100)) : 0;
    const statuses = Object.entries(STATUS).map(([k, v]) => `<button class="chip-btn ${o.status === k ? 'on' : ''}" data-act="set-status" data-id="${o.id}" data-s="${k}">${v[0]}</button>`).join('');
    const row = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
    openSheet(`
      <div class="row"><h2>${esc(o.client) || 'Без имени'}</h2><span class="chip ${stCls}">${stName}</span></div>
      <div class="hint" style="margin-top:-6px">📅 ${esc(fmtLong(orderDate(o)))}${o.time ? ' · ' + esc(o.time) : ''} ${dueBadge(o)}</div>
      ${o.contact ? `<div class="quick"><span class="v">${esc(o.contact)}</span>${contactActions(o.contact)}</div>` : ''}

      <div class="panel"><div class="kv">
        ${row('Получение', o.delivery === 'delivery' ? '🚗 Доставка' + (o.address ? ': ' + esc(o.address) : '') : 'Самовывоз')}
        ${row('Вес', o.weight ? kg(o.weight) + (o.servings ? ` · ${esc(o.servings)} порций` : '') : (o.servings ? `${esc(o.servings)} порций` : ''))}
        ${row('Бисквит', esc(o.flavor))}
        ${row('Начинка', esc(o.filling))}
        ${row('Дизайн', esc(o.design))}
        ${row('Надпись', esc(o.inscription))}
        ${row('⚠️ Аллергии', esc(o.allergies))}
        ${row('Заметки', esc(o.notes))}
      </div></div>
      ${(o.files || []).length ? `<div class="label">Фото</div>${attachHTML(o.files, false, { kind: 'order', id: o.id })}` : lostHint(o)}

      <div class="panel">
        <div class="row"><b style="font-size:20px">${money(o.price)}</b>${debt > 0 ? `<span class="debt">осталось ${money(debt)}</span>` : (o.price > 0 ? '<span class="paid">оплачено ✓</span>' : '')}</div>
        <div class="track" style="margin:10px 0"><i style="width:${pct}%"></i></div>
        <div class="pay"><span>Оплачено</span><b>${money(o.paid)}</b></div>
        ${(o.payments || []).map((p) => `<div class="pay"><span>${fmtDate(p.date)}</span><span>+ ${money(p.amount)}</span></div>`).join('')}
        <button class="btn block ghost" style="margin-top:8px" data-act="add-pay" data-id="${o.id}">＋ Добавить оплату</button>
      </div>

      <div class="label">Статус заказа</div><div class="status-row">${statuses}</div>
      <div class="actions"><button class="btn ghost" data-act="edit-order" data-id="${o.id}">✏️ Изменить</button><button class="btn danger" data-act="del-order" data-id="${o.id}">Удалить</button></div>
    `);
  }

  function openPayForm(id) {
    const o = orders.find((x) => x.id === id);
    const debt = debtOf(o);
    openSheet(`<form data-form="pay" data-id="${id}">
      <h2>Новая оплата 💸</h2>
      <div class="hint">${esc(o.client)} · осталось ${money(debt)}</div>
      <label>Сумма<input name="amount" required inputmode="decimal" placeholder="0" value="${debt || ''}"></label>
      <div class="quick">
        ${debt > 0 ? `<button type="button" class="chip-btn" data-act="pay-fill" data-v="${debt}">Весь остаток</button>` : ''}
        ${o.price > 0 && !o.paid ? `<button type="button" class="chip-btn" data-act="pay-fill" data-v="${Math.round(o.price / 2)}">Предоплата 50%</button>` : ''}
      </div>
      <div class="actions"><button type="button" class="btn ghost" data-act="close">Отмена</button><button class="btn" type="submit">Добавить</button></div>
    </form>`);
  }

  async function saveOrder(form) {
    const f = new FormData(form);
    const id = form.dataset.id || uid();
    const old = orders.find((o) => o.id === id);
    const s = (k) => String(f.get(k) || '').trim();
    const o = {
      ...(old || {}),
      id, createdAt: old ? old.createdAt : new Date().toISOString(),
      client: s('client'), contact: s('contact'), date: f.get('date') || todayStr(), time: s('time'),
      delivery: f.get('delivery') || 'pickup', address: s('address'),
      weight: num(f.get('weight')), servings: s('servings'), flavor: s('flavor'), filling: s('filling'), design: s('design'),
      inscription: s('inscription'), allergies: s('allergies'), notes: s('notes'),
      price: num(f.get('price')), paid: num(f.get('paid')), status: f.get('status') || 'new', files: draftFiles,
    };
    await dbPut('orders', o);
    orders = orders.filter((x) => x.id !== id).concat(o);
    closeSheet(); render(); haptic(); toast('Заказ сохранён 🌸');
  }

  async function updateOrder(id, patch) {
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    Object.assign(o, patch);
    await dbPut('orders', o);
    closeSheet(true); render(); openOrderDetail(id); haptic();
  }

  /* ---------- recipes ---------- */
  const allCats = () => Array.from(new Set(DEFAULT_CATS.concat(recipes.map((r) => r.category).filter(Boolean))));

  function recipesListHTML() {
    const q = state.rq.trim().toLowerCase();
    const list = recipes.filter((r) => {
      if (state.recipeCat !== 'all' && r.category !== state.recipeCat) return false;
      return !q || [r.title, r.steps, r.category, (r.ings || []).map((i) => i.name).join(' ')].some((x) => String(x || '').toLowerCase().includes(q));
    }).sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    if (!list.length) return `<div class="empty"><div class="big">📖</div>${recipes.length ? 'Ничего не нашлось' : 'Здесь будут рецепты и техкарты.<br>Нажмите «＋», чтобы добавить 🌸'}</div>`;
    return list.map((r) => {
      const bits = [r.category, r.yield ? `⚖️ ${esc(r.yield)}` : '', (r.ings || []).length ? `${r.ings.length} ингр.` : '', (r.files || []).length ? `📎 ${r.files.length}` : ''].filter(Boolean).join(' · ');
      return `<div class="card" data-act="open-recipe" data-id="${r.id}">
        <div class="row"><div class="title">${esc(r.title)}</div><span class="chip">${KINDS[r.kind] || 'Рецепт'}</span></div>
        <div class="sub">${bits || 'Без категории'}</div></div>`;
    }).join('');
  }

  function renderRecipes() {
    const cats = Array.from(new Set(recipes.map((r) => r.category).filter(Boolean)));
    const chip = (k, t) => `<button class="chip-btn ${state.recipeCat === k ? 'on' : ''}" data-act="cat" data-c="${esc(k)}">${esc(t)}</button>`;
    return `<input class="search" id="rq" type="search" placeholder="🔍 Поиск по рецептам и ингредиентам…" value="${esc(state.rq)}">
      ${cats.length ? `<div class="chips">${chip('all', 'Все')}${cats.map((c) => chip(c, c)).join('')}</div>` : ''}
      <div id="rlist">${recipesListHTML()}</div>
      <button class="fab" data-act="add-recipe" aria-label="Новый рецепт">＋</button>`;
  }

  function ingRowsHTML() {
    return draftIngs.map((g, i) => `<div class="ing-row">
      <input data-i="${i}" data-f="name" placeholder="Ингредиент" value="${esc(g.name)}">
      <div class="grid3">
        <input data-i="${i}" data-f="amount" inputmode="decimal" placeholder="Кол-во" value="${esc(g.amount)}">
        <select data-i="${i}" data-f="unit">${UNITS.map((u) => `<option ${g.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <button type="button" data-act="rm-ing" data-i="${i}" aria-label="Убрать">✕</button>
      </div></div>`).join('');
  }
  const refreshIngs = () => { const el = $('#ings'); if (el) el.innerHTML = ingRowsHTML(); };

  function recipeFormHTML(r) {
    const isNew = !r;
    r = r || { kind: 'recipe' };
    return `<form data-form="recipe" data-id="${esc(r.id || '')}">
      <h2>${isNew ? 'Новый рецепт 📖' : 'Редактировать'}</h2>
      <label>Название<input name="title" required value="${esc(r.title)}" placeholder="Например: Медовик"></label>
      <div class="grid2">
        <label>Тип<select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Категория<input name="category" list="cats" value="${esc(r.category)}" placeholder="Торты"><datalist id="cats">${allCats().map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      </div>

      <div class="fsec">🥣 Ингредиенты</div>
      <div id="ings"></div>
      <button type="button" class="linkbtn" data-act="add-ing">＋ Добавить ингредиент</button>

      <div class="fsec">👩‍🍳 Приготовление</div>
      <label>Шаги<textarea name="steps" rows="7" placeholder="1. Смешать…&#10;2. Выпекать при 180° 25 минут…">${esc(r.steps)}</textarea></label>

      <details class="more">
        <summary>＋ Ещё детали</summary>
        <div class="grid2">
          <label>Выход<input name="yield" value="${esc(r.yield)}" placeholder="1,2 кг / 16 порц."></label>
          <label>Время<input name="time" value="${esc(r.time)}" placeholder="1 ч 30 мин"></label>
        </div>
        <div class="grid2">
          <label>Срок хранения<input name="shelf" value="${esc(r.shelf)}" placeholder="3 дня в холодильнике"></label>
          <label>Себестоимость<input name="cost" inputmode="decimal" value="${r.cost || ''}" placeholder="0"></label>
        </div>
        <label>Заметки и секреты<textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
      </details>

      <div class="fsec">📎 Файлы</div>
      <div class="hint">Фото, PDF, документы с технологической картой</div>
      <div id="attach"></div>
      <label class="filebtn">📎 Загрузить файл<input type="file" id="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.rtf,.odt" multiple hidden></label>

      <div class="actions"><button type="button" class="btn ghost" data-act="close">Отмена</button><button class="btn" type="submit">Сохранить</button></div>
    </form>`;
  }

  function openRecipeForm(r) {
    draftFiles = r && r.files ? r.files.slice() : [];
    draftIngs = r && r.ings ? r.ings.map((x) => ({ ...x })) : [{ name: '', amount: '', unit: 'г' }];
    const el = openSheet(recipeFormHTML(r));
    if (r && (r.yield || r.time || r.shelf || r.cost || r.notes)) $('details.more', el).open = true;
    refreshIngs(); refreshAttach();
  }

  function ingBlockHTML(r, scale) {
    const chips = [0.5, 1, 1.5, 2, 3].map((s) => `<button class="chip-btn ${s === scale ? 'on' : ''}" data-act="scale" data-id="${r.id}" data-s="${s}">×${fmtAmt(s)}</button>`).join('');
    const list = r.ings.map((g) => `<div class="ing"><span>${esc(g.name)}</span><b>${g.amount !== '' && g.amount != null ? fmtAmt(num(g.amount) * scale) + ' ' + esc(g.unit) : ''}</b></div>`).join('');
    return `<div class="label">Пересчитать порцию</div><div class="chips" style="padding-top:6px">${chips}</div><div class="panel" style="margin-top:4px">${list}</div>`;
  }

  function openRecipeDetail(id) {
    const r = recipes.find((x) => x.id === id);
    if (!r) return;
    const meta = [r.yield ? `⚖️ ${esc(r.yield)}` : '', r.time ? `⏱ ${esc(r.time)}` : '', r.shelf ? `🧊 ${esc(r.shelf)}` : '', r.cost ? `💰 себестоимость ${money(r.cost)}` : ''].filter(Boolean);
    openSheet(`
      <div class="row"><h2>${esc(r.title)}</h2><span class="chip">${KINDS[r.kind] || 'Рецепт'}</span></div>
      <div class="hint" style="margin-top:-6px">${esc(r.category || 'Без категории')}</div>
      ${meta.length ? `<div class="meta">${meta.map((m) => `<span class="chip">${m}</span>`).join('')}</div>` : ''}
      ${(r.ings || []).length ? `<div id="ing-block">${ingBlockHTML(r, 1)}</div>` : ''}
      ${r.steps ? `<div class="label">Приготовление</div><div class="text">${esc(r.steps)}</div>` : ''}
      ${r.notes ? `<div class="label">Заметки</div><div class="text">${esc(r.notes)}</div>` : ''}
      ${(r.files || []).length ? `<div class="label">Файлы</div>${attachHTML(r.files, false, { kind: 'recipe', id: r.id })}` : lostHint(r)}
      <div class="actions"><button class="btn ghost" data-act="edit-recipe" data-id="${r.id}">✏️ Изменить</button><button class="btn danger" data-act="del-recipe" data-id="${r.id}">Удалить</button></div>
    `);
  }

  async function saveRecipe(form) {
    const f = new FormData(form);
    const id = form.dataset.id || uid();
    const s = (k) => String(f.get(k) || '').trim();
    const r = {
      id, updatedAt: new Date().toISOString(), title: s('title'), kind: f.get('kind') || 'recipe', category: s('category'),
      ings: draftIngs.filter((g) => String(g.name).trim()).map((g) => ({ name: String(g.name).trim(), amount: String(g.amount).trim(), unit: g.unit })),
      steps: s('steps'), yield: s('yield'), time: s('time'), shelf: s('shelf'), cost: num(f.get('cost')), notes: s('notes'), files: draftFiles,
    };
    await dbPut('recipes', r);
    recipes = recipes.filter((x) => x.id !== id).concat(r);
    closeSheet(); render(); haptic(); toast('Рецепт сохранён 🌸');
  }

  /* ---------- home ---------- */
  function renderHome() {
    const t = todayStr();
    const active = orders.filter((o) => ACTIVE.includes(o.status)).sort(byDate);
    const overdue = active.filter((o) => orderDate(o) < t);
    const today = active.filter((o) => orderDate(o) === t);
    const soon = active.filter((o) => orderDate(o) > t).slice(0, 4);
    const debt = orders.filter((o) => o.status !== 'cancel').reduce((a, o) => a + debtOf(o), 0);
    const ms = monthStats(t.slice(0, 7));
    return `
      ${overdue.length ? `<div class="alert" data-act="filter-go">⚠️ Просроченных заказов: ${overdue.length}. Проверьте и отметьте «Выдан».</div>` : ''}
      <div class="actions3">
        <button class="btn" data-act="add-order"><span>🎂</span>Заказ</button>
        <button class="btn ghost" data-act="add-recipe"><span>📖</span>Рецепт</button>
        <button class="btn ghost" data-act="add-expense"><span>🧾</span>Расход</button>
      </div>
      <h3>Сегодня · ${today.length}</h3>
      ${today.length ? today.map(orderCard).join('') : '<div class="card"><div class="hint">На сегодня заказов нет. Можно выдохнуть 🌸</div></div>'}
      ${soon.length ? `<h3>Скоро</h3>${soon.map(orderCard).join('')}` : ''}
      <h3>Коротко о деньгах</h3>
      <div class="stats">
        <div class="stat"><div class="k">Ждём оплату</div><div class="v ${debt > 0 ? '' : 'pos'}">${money(debt)}</div></div>
        <div class="stat"><div class="k">Прибыль за ${MONTHS[Number(t.slice(5, 7)) - 1].toLowerCase()}</div><div class="v ${ms.profit < 0 ? 'neg' : 'pos'}">${money(ms.profit)}</div></div>
      </div>`;
  }

  /* ---------- income ---------- */
  const prevMonth = (mk) => { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  function monthStats(mk) {
    const os = orders.filter((o) => o.status !== 'cancel' && orderDate(o).slice(0, 7) === mk);
    const ex = expenses.filter((e) => (e.date || '').slice(0, 7) === mk).sort((a, b) => b.date.localeCompare(a.date));
    const revenue = sum(os, 'price'), spent = sum(ex, 'amount');
    return { os, ex, revenue, spent, profit: revenue - spent, received: sum(os, 'paid'), debt: os.reduce((a, o) => a + debtOf(o), 0), kg: sum(os, 'weight') };
  }

  function bars(items) { // [{label, value, text}]
    const max = Math.max(...items.map((i) => i.value), 1);
    return items.map((i) => `<div class="bar"><div class="bar-top"><span>${esc(i.label)}</span><b>${i.text}</b></div><div class="track"><i style="width:${Math.max(3, Math.round((i.value / max) * 100))}%"></i></div></div>`).join('');
  }

  function shiftMonth(delta) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function renderIncome() {
    const [y, m] = state.month.split('-').map(Number);
    const s = monthStats(state.month), p = monthStats(prevMonth(state.month));
    const cnt = s.os.length;
    let delta = 'Нет данных за прошлый месяц';
    if (p.revenue > 0) { const pct = Math.round(((s.revenue - p.revenue) / p.revenue) * 100); delta = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% выручки к прошлому месяцу`; }

    const dim = new Date(y, m, 0).getDate();
    const weekDefs = [[1, 7], [8, 14], [15, 21], [22, dim]];
    const weeks = weekDefs.map(([a, b]) => {
      const v = s.os.filter((o) => { const d = Number(orderDate(o).slice(8, 10)); return d >= a && d <= b; }).reduce((acc, o) => acc + o.price, 0);
      return { label: `${a}–${b} ${MON_SHORT[m - 1]}`, value: v, text: money(v) };
    });

    const fm = {};
    s.os.forEach((o) => {
      const raw = (o.filling || '').trim(); if (!raw) return;
      const k = raw.toLowerCase(); fm[k] = fm[k] || { label: raw, n: 0, rev: 0 }; fm[k].n += 1; fm[k].rev += o.price;
    });
    const fills = Object.values(fm).sort((a, b) => b.n - a.n || b.rev - a.rev).slice(0, 5).map((f) => ({ label: f.label, value: f.n, text: `${f.n} шт · ${money(f.rev)}` }));

    const ec = {};
    s.ex.forEach((e) => { const k = e.cat || 'Другое'; ec[k] = (ec[k] || 0) + e.amount; });
    const expCats = Object.entries(ec).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v, text: money(v) }));
    const unpaid = s.os.filter((o) => debtOf(o) > 0).sort(byDate);

    return `<div class="monthbar">
        <button data-act="month" data-d="-1" aria-label="Назад">‹</button>
        <div class="label">${MONTHS[m - 1]} ${y}</div>
        <button data-act="month" data-d="1" aria-label="Вперёд">›</button>
      </div>
      <div class="hero"><div class="k">Прибыль (выручка − расходы)</div><div class="v">${money(s.profit)}</div><div class="d">${delta}</div></div>
      <div class="stats">
        <div class="stat"><div class="k">Выручка</div><div class="v">${money(s.revenue)}</div></div>
        <div class="stat"><div class="k">Расходы</div><div class="v">${money(s.spent)}</div></div>
        <div class="stat"><div class="k">Получено</div><div class="v">${money(s.received)}</div></div>
        <div class="stat"><div class="k">Ждём оплату</div><div class="v ${s.debt > 0 ? '' : 'pos'}">${money(s.debt)}</div></div>
        <div class="stat"><div class="k">Заказов</div><div class="v">${cnt}</div></div>
        <div class="stat"><div class="k">Средний чек</div><div class="v">${money(cnt ? s.revenue / cnt : 0)}</div></div>
        <div class="stat wide"><div class="k">Всего испечено</div><div class="v">${kg(s.kg)}</div></div>
      </div>
      ${s.revenue > 0 ? `<h3>Выручка по неделям</h3><div class="card">${bars(weeks)}</div>` : ''}
      ${fills.length ? `<h3>Любимые начинки</h3><div class="card">${bars(fills)}</div>` : ''}
      ${unpaid.length ? `<h3>Ждут оплаты</h3>${unpaid.map(orderCard).join('')}` : ''}
      <h3>Расходы</h3>
      ${expCats.length ? `<div class="card">${bars(expCats)}</div>` : ''}
      ${s.ex.length ? s.ex.map((e) => `<div class="card"><div class="row"><div style="min-width:0"><div class="title">${esc(e.name) || 'Расход'}</div><div class="sub">${fmtDate(e.date)} · ${esc(e.cat || 'Другое')}</div></div><div class="row"><b>${money(e.amount)}</b><button class="btn danger small" data-act="del-expense" data-id="${e.id}" aria-label="Удалить">✕</button></div></div></div>`).join('') : '<div class="card"><div class="hint">Расходов за месяц нет</div></div>'}
      <button class="btn block" style="margin-top:14px" data-act="add-expense">🧾 Добавить расход</button>`;
  }

  function openExpenseForm() {
    openSheet(`<form data-form="expense">
      <h2>Новый расход 🧾</h2>
      <label>Что купили<input name="name" required placeholder="Мука, сливки, коробки…"></label>
      <div class="grid2">
        <label>Сумма<input name="amount" required inputmode="decimal" placeholder="0"></label>
        <label>Дата<input type="date" name="date" required value="${todayStr()}"></label>
      </div>
      <label>Категория<select name="cat">${EXP_CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <div class="actions"><button type="button" class="btn ghost" data-act="close">Отмена</button><button class="btn" type="submit">Сохранить</button></div>
    </form>`);
  }

  async function saveExpense(form) {
    const f = new FormData(form);
    const e = { id: uid(), name: String(f.get('name')).trim(), amount: num(f.get('amount')), date: f.get('date') || todayStr(), cat: f.get('cat') || 'Другое' };
    await dbPut('expenses', e);
    expenses.push(e);
    state.month = e.date.slice(0, 7);
    closeSheet(); render(); haptic(); toast('Расход добавлен');
  }

  /* ---------- облако Telegram: автокопия текстовых данных ---------- */
  const csCall = (m, ...a) => new Promise((res, rej) => cs[m](...a, (err, v) => (err ? rej(new Error(String(err))) : res(v))));
  const csGet = (keys) => csCall('getItems', keys);
  const csSet = (k, v) => csCall('setItem', k, v);
  const csRemove = (keys) => csCall('removeItems', keys);
  let cloudTimer = null, cloudReady = false, cloudInfo = { at: null, err: null };
  const parseMeta = (v) => { try { const m = JSON.parse(v); return m && m.n ? m : null; } catch (e) { return null; } };
  const stripFiles = (rows) => rows.map(({ files, ...rest }) => ({ ...rest, lostFiles: (files || []).map((f) => f.name).concat(rest.lostFiles || []) }));

  function chunkString(str, size) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      let j = Math.min(i + size, str.length);
      const c = str.charCodeAt(j - 1);
      if (c >= 0xD800 && c <= 0xDBFF && j < str.length) j += 1; // не режем эмодзи пополам
      out.push(str.slice(i, j)); i = j;
    }
    return out;
  }

  function scheduleCloud() {
    if (!cs || !cloudReady) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => { cloudTimer = null; cloudSave(); }, 1500);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && cloudTimer) { clearTimeout(cloudTimer); cloudTimer = null; cloudSave(); } });

  // Две «ячейки» (a/b) по очереди: если запись прервётся, прошлая копия остаётся целой
  async function cloudSave() {
    if (!cs || !cloudReady) return false;
    try {
      const snap = JSON.stringify({ v: 1, settings, orders: stripFiles(orders), recipes: stripFiles(recipes), expenses });
      const chunks = chunkString(snap, 1300);
      if (chunks.length > 450) throw new Error('Слишком много данных для облака Telegram');
      const prev = parseMeta((await csGet(['bk_meta'])).bk_meta);
      const slot = prev && prev.s === 'a' ? 'b' : 'a';
      for (let i = 0; i < chunks.length; i += 8) await Promise.all(chunks.slice(i, i + 8).map((c, k) => csSet(slot + (i + k), c)));
      await csSet('bk_meta', JSON.stringify({ s: slot, n: chunks.length, at: new Date().toISOString() }));
      if (prev) { const rm = []; for (let i = 0; i < prev.n; i++) rm.push(prev.s + i); for (let i = 0; i < rm.length; i += 40) await csRemove(rm.slice(i, i + 40)); }
      cloudInfo = { at: new Date(), err: null };
      return true;
    } catch (e) { cloudInfo = { at: cloudInfo.at, err: String((e && e.message) || e) }; return false; }
  }

  // возвращает true, если проверка облака прошла (даже если копии нет)
  async function cloudRestore(auto) {
    if (!cs) { if (!auto) toast('Облако Telegram недоступно в этой версии'); return false; }
    if (auto && (orders.length || recipes.length || expenses.length)) return true;
    try {
      const meta = parseMeta((await csGet(['bk_meta'])).bk_meta);
      if (!meta) { if (!auto) toast('В облаке пока ничего нет'); return true; }
      const when = new Date(meta.at).toLocaleString('ru-RU');
      if (!(await ask(`Нашли копию в облаке Telegram от ${when}. Восстановить заказы, рецепты и расходы? (Фото и файлы в облако не попадают.)`))) return true;
      let json = '';
      for (let i = 0; i < meta.n; i += 40) {
        const keys = []; for (let j = i; j < Math.min(meta.n, i + 40); j++) keys.push(meta.s + j);
        const part = await csGet(keys); keys.forEach((k) => { json += part[k] || ''; });
      }
      const snap = JSON.parse(json);
      let added = 0;
      for (const [store, list, have] of [['orders', snap.orders, orders], ['recipes', snap.recipes, recipes], ['expenses', snap.expenses, expenses]]) {
        const ids = new Set(have.map((x) => x.id));
        for (const rec of list || []) if (!ids.has(rec.id)) { await dbPut(store, { ...rec, files: [] }); added += 1; }
      }
      if (snap.settings) { Object.assign(settings, snap.settings); saveSettings(); }
      await loadAll(); render(); haptic(); toast(`Восстановлено записей: ${added} ☁️`);
      return true;
    } catch (e) { console.error(e); haptic('error'); toast('Не удалось восстановить из облака'); return false; }
  }

  /* ---------- settings & backup ---------- */
  function cloudStatus() {
    if (!cs) return 'Недоступно в этой версии Telegram. Обновите приложение Telegram.';
    if (cloudInfo.err) return `⚠️ Ошибка: ${esc(cloudInfo.err)}`;
    if (cloudInfo.at) return `✅ Сохранено ${cloudInfo.at.toLocaleString('ru-RU')}`;
    return 'Включено. Копия обновляется сама после каждого изменения.';
  }

  function openSettings() {
    const who = tgUser ? `${esc(tgUser.first_name || '')} ${esc(tgUser.last_name || '')}${tgUser.username ? ' (@' + esc(tgUser.username) + ')' : ''}` : 'Открыто вне Telegram';
    openSheet(`<form data-form="settings">
      <h2>Настройки ⚙️</h2>
      <div class="hint">${who}</div>
      <div class="grid2">
        <label>Валюта<input name="currency" value="${esc(settings.currency)}" maxlength="6" placeholder="₴, €, $, грн"></label>
        <label>Цена за 1 кг<input name="pricePerKg" inputmode="decimal" value="${settings.pricePerKg || ''}" placeholder="для расчёта"></label>
      </div>
      <div class="actions"><button class="btn" type="submit">Сохранить</button></div>

      <h3>☁️ Облако Telegram</h3>
      <div class="hint" id="cloud-status">${cloudStatus()}</div>
      <div class="hint" style="margin:6px 0 10px">Заказы, рецепты (текст), расходы и настройки копируются в облако Telegram автоматически. На новом телефоне приложение предложит их вернуть. Фото и файлы в облако не попадают.</div>
      <div class="actions" style="margin-top:0">
        <button type="button" class="btn ghost" data-act="cloud-save">☁️ Сохранить сейчас</button>
        <button type="button" class="btn ghost" data-act="cloud-restore">Восстановить</button>
      </div>

      <h3>Файл с полной копией (с фото)</h3>
      <div class="hint" style="margin-bottom:10px">В некоторых версиях Telegram сохранение файла может не сработать. Тогда ориентируйтесь на облачную копию выше.</div>
      <div class="actions" style="margin-top:0">
        <button type="button" class="btn ghost" data-act="export">⬇️ Скачать копию</button>
        <button type="button" class="btn ghost" data-act="import">⬆️ Из файла</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </form>`);
  }

  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  const packFiles = (files) => Promise.all((files || []).map(async (f) => ({ name: f.name, type: f.type, data: await blobToDataURL(f.blob) })));
  const unpackFiles = (files) => Promise.all((files || []).map(async (f) => ({ name: f.name, type: f.type, blob: await (await fetch(f.data)).blob() })));

  async function exportData() {
    try {
      toast('Готовлю копию…');
      const dump = {
        v: 1, exportedAt: new Date().toISOString(), settings,
        orders: await Promise.all(orders.map(async (o) => ({ ...o, files: await packFiles(o.files) }))),
        recipes: await Promise.all(recipes.map(async (r) => ({ ...r, files: await packFiles(r.files) }))),
        expenses,
      };
      const file = new File([JSON.stringify(dump)], `cake-backup-${todayStr()}.json`, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000));
        await Promise.race([navigator.share({ files: [file] }), timeout]);
        toast('Готово ✅');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file); a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        toast('Если файл не появился, этот телефон не умеет сохранять файлы из Telegram. Используйте ☁️ облачную копию.');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Файл сохранить не удалось. Используйте ☁️ облачную копию.');
    }
  }

  async function importData(file) {
    try {
      const dump = JSON.parse(await file.text());
      if (!dump || dump.v !== 1) throw new Error('format');
      if (!(await ask('Добавить данные из копии? Записи с одинаковыми id будут перезаписаны.'))) return;
      for (const o of dump.orders || []) await dbPut('orders', { ...o, files: await unpackFiles(o.files) });
      for (const r of dump.recipes || []) await dbPut('recipes', { ...r, files: await unpackFiles(r.files) });
      for (const e of dump.expenses || []) await dbPut('expenses', e);
      if (dump.settings) { Object.assign(settings, dump.settings); saveSettings(); }
      await loadAll(); closeSheet(); render(); haptic(); toast('Данные восстановлены');
    } catch (e) { haptic('error'); toast('Не удалось прочитать файл копии'); }
  }

  /* ---------- render & events ---------- */
  function render() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $('#view').innerHTML = { home: renderHome, orders: renderOrders, recipes: renderRecipes, income: renderIncome }[state.tab]();
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'tab': state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
      case 'filter-go': state.tab = 'orders'; state.orderFilter = 'active'; render(); break;
      case 'filter': state.orderFilter = el.dataset.f; render(); break;
      case 'cat': state.recipeCat = el.dataset.c; render(); break;
      case 'month': shiftMonth(Number(el.dataset.d)); render(); break;
      case 'close': closeSheet(); break;
      case 'settings': openSettings(); break;

      case 'add-order': openOrderForm(); break;
      case 'open-order': openOrderDetail(id); break;
      case 'edit-order': { const o = orders.find((x) => x.id === id); closeSheet(true); openOrderForm(o); break; }
      case 'set-status': updateOrder(id, { status: el.dataset.s }); break;
      case 'add-pay': openPayForm(id); break;
      case 'pay-fill': { const i = $('input[name=amount]'); if (i) i.value = el.dataset.v; break; }
      case 'calc-price': {
        const form = el.closest('form'); const w = num(form.elements.weight.value);
        if (!w) { toast('Сначала укажите вес'); break; }
        form.elements.price.value = fmtAmt(w * settings.pricePerKg); break;
      }
      case 'del-order':
        if (await ask('Удалить заказ?')) { await dbDel('orders', id); orders = orders.filter((x) => x.id !== id); closeSheet(); render(); toast('Удалено'); }
        break;

      case 'add-recipe': openRecipeForm(); break;
      case 'open-recipe': openRecipeDetail(id); break;
      case 'edit-recipe': { const r = recipes.find((x) => x.id === id); closeSheet(true); openRecipeForm(r); break; }
      case 'del-recipe':
        if (await ask('Удалить рецепт?')) { await dbDel('recipes', id); recipes = recipes.filter((x) => x.id !== id); closeSheet(); render(); toast('Удалено'); }
        break;
      case 'scale': { const r = recipes.find((x) => x.id === id); const b = $('#ing-block'); if (r && b) b.innerHTML = ingBlockHTML(r, Number(el.dataset.s)); break; }
      case 'add-ing': {
        draftIngs.push({ name: '', amount: '', unit: 'г' }); refreshIngs();
        const rows = document.querySelectorAll('#ings .ing-row'); const last = rows[rows.length - 1];
        if (last) last.querySelector('input').focus();
        break;
      }
      case 'rm-ing': draftIngs.splice(Number(el.dataset.i), 1); refreshIngs(); break;

      case 'add-expense': openExpenseForm(); break;
      case 'del-expense':
        if (await ask('Удалить расход?')) { await dbDel('expenses', id); expenses = expenses.filter((x) => x.id !== id); render(); }
        break;

      case 'rm-file': draftFiles.splice(Number(el.dataset.i), 1); refreshAttach(); break;
      case 'view-img': openImage(el.src, el.alt); break;
      case 'open-file': {
        const [kind, rid] = el.dataset.ref.split(':');
        const rec = (kind === 'order' ? orders : recipes).find((x) => x.id === rid);
        const f = rec && (rec.files || [])[Number(el.dataset.i)];
        if (f) openFile(f);
        break;
      }
      case 'vz': {
        const v = el.closest('.viewer2');
        if (v) { v._zi = Math.max(0, Math.min(v._levels - 1, v._zi + Number(el.dataset.d))); v._apply(v); }
        break;
      }
      case 'cloud-save': {
        if (!cs) { toast('Облако недоступно в этой версии Telegram'); break; }
        if (!cloudReady) { toast('Облако ещё проверяется, подождите пару секунд'); break; }
        toast('Сохраняю…');
        const ok = await cloudSave();
        const st = $('#cloud-status'); if (st) st.innerHTML = cloudStatus();
        toast(ok ? 'Сохранено в облако ☁️' : 'Не удалось сохранить в облако');
        break;
      }
      case 'cloud-restore': cloudRestore(false); break;
      case 'export': exportData(); break;
      case 'import': $('#import-file').click(); break;
      default: break;
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    try {
      switch (form.dataset.form) {
        case 'order': await saveOrder(form); break;
        case 'recipe': await saveRecipe(form); break;
        case 'expense': await saveExpense(form); break;
        case 'pay': {
          const id = form.dataset.id; const o = orders.find((x) => x.id === id);
          const amount = num(new FormData(form).get('amount'));
          if (!amount) { toast('Введите сумму'); break; }
          o.paid = (Number(o.paid) || 0) + amount;
          o.payments = (o.payments || []).concat({ date: todayStr(), amount });
          await dbPut('orders', o);
          closeSheet(true); closeSheet(true); render(); openOrderDetail(id); haptic(); toast('Оплата добавлена 💸');
          break;
        }
        case 'settings': {
          const f = new FormData(form);
          settings.currency = String(f.get('currency') || '').trim() || '₴';
          settings.pricePerKg = num(f.get('pricePerKg'));
          saveSettings(); closeSheet(); render(); toast('Сохранено');
          break;
        }
        default: break;
      }
    } catch (err) { haptic('error'); toast('Ошибка сохранения'); console.error(err); }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'q') { state.q = t.value; $('#list').innerHTML = ordersListHTML(); }
    if (t.id === 'rq') { state.rq = t.value; $('#rlist').innerHTML = recipesListHTML(); }
    if (t.dataset && t.dataset.f && t.closest('#ings')) draftIngs[Number(t.dataset.i)][t.dataset.f] = t.value;
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.f && t.closest('#ings')) draftIngs[Number(t.dataset.i)][t.dataset.f] = t.value;
    if (t.name === 'delivery') { const w = $('#addr-wrap'); if (w) w.hidden = t.value !== 'delivery'; }
    if (t.id === 'file') {
      const files = Array.from(t.files || []);
      t.value = '';
      if (!files.length) return;
      toast('Загружаю…');
      for (const f of files) {
        const small = await shrink(f);
        draftFiles.push({ name: small.name, type: small.type, blob: small });
      }
      refreshAttach();
      if (files.some((f) => !isImg(f) && !isPdf(f) && !isText(f))) toast('Word и Excel нельзя просмотреть внутри приложения. Лучше загрузить PDF или фото 🌸');
    }
    if (t.id === 'import-file' && t.files[0]) { importData(t.files[0]); t.value = ''; }
  });

  /* ---------- init ---------- */
  async function loadAll() { [orders, recipes, expenses] = await Promise.all(STORES.map(dbAll)); }

  function setHeader() {
    const name = tgUser && (tgUser.first_name || tgUser.username);
    $('#hello').textContent = name ? `Привет, ${name} 🌸` : 'Привет 🌸';
    $('#today').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  (async function init() {
    setHeader();
    try {
      db = await openDB();
      await loadAll();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      render();
      setTimeout(async () => { cloudReady = await cloudRestore(true); }, 300);
    } catch (err) {
      console.error(err);
      $('#view').innerHTML = '<div class="empty"><div class="big">⚠️</div>Не удалось открыть хранилище.<br>Попробуйте перезапустить Telegram.</div>';
    }
  })();
})();
