'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const initial = (name) => esc(String(name || '?').slice(0, 1).toUpperCase());

const S = {
  me: null,
  providers: [],
  shares: [],
  peers: [],
  requests: [],
  pairCode: null,
  codeTtl: 10 * 60 * 1000,
  editingProvider: null,
};

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

function snippet(protocol, key) {
  const base = `http://127.0.0.1:${S.me.proxyPort}`;
  return protocol === 'anthropic'
    ? `ANTHROPIC_BASE_URL=${base}\nANTHROPIC_AUTH_TOKEN=${key}`
    : `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=${key}`;
}

function progress(used, limit) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
  return `<div class="progress"><i class="${cls}" style="width:${pct}%"></i></div>`;
}

function onlineDot(online) {
  return `<span class="dot ${online ? 'on' : ''}" title="${online ? '在线' : '离线'}"></span>`;
}

function showApp() {
  $('setup').classList.add('hidden');
  $('tabs').classList.remove('hidden');
  $('app').classList.remove('hidden');
  $('status').textContent = `${S.me.name} · 服务器${S.me.relayOnline ? '在线' : '离线'}`;
  $('status').className = 'status' + (S.me.relayOnline ? ' on' : '');
  $('proxy-hint').textContent = `本机代理：http://127.0.0.1:${S.me.proxyPort}（Claude Code / Codex 指向这里）`;
}

async function boot() {
  const me = await api('/api/me');
  if (!me.configured) {
    $('setup').classList.remove('hidden');
    return;
  }
  S.me = me;
  showApp();
  await loadAll();
}

async function loadAll() {
  const [providers, shares, peers, pair, requests] = await Promise.all([
    api('/api/providers'),
    api('/api/shares'),
    api('/api/peers'),
    api('/api/pair'),
    api('/api/requests?limit=100'),
  ]);
  S.providers = providers;
  S.shares = shares;
  S.peers = peers;
  S.pairCode = pair.code;
  S.requests = requests.sort((x, y) => y.created_at - x.created_at);
  renderAll();
}

function renderAll() {
  renderStatus();
  renderCode();
  renderProviderList();
  renderShares();
  renderPeers();
  renderUsage();
}

function renderStatus() {
  $('status').textContent = `${S.me.name} · 服务器${S.me.relayOnline ? '在线' : '离线'}`;
  $('status').className = 'status' + (S.me.relayOnline ? ' on' : '');
}

function renderCode() {
  $('my-fingerprint').textContent = S.me ? `我的公钥指纹：${S.me.fingerprint}` : '';
  if (!S.pairCode) {
    $('code-display').textContent = '— — — — — —';
    $('code-state').textContent = '未生成';
    $('countdown-bar').style.width = '0%';
    return;
  }
  const left = S.pairCode.expiresAt - Date.now();
  if (left <= 0) {
    S.pairCode = null;
    renderCode();
    return;
  }
  $('code-display').textContent = S.pairCode.code.split('').join(' ');
  $('code-state').textContent = `${Math.ceil(left / 60000)} 分钟后过期`;
  $('countdown-bar').style.width = Math.max(0, Math.min(100, (left / S.codeTtl) * 100)) + '%';
}

function renderPeerCards() {
  const box = $('peer-cards');
  if (!S.peers.length) {
    box.innerHTML = '<div class="empty">还没有配对，把上面的验证码告诉对方吧。</div>';
    return;
  }
  box.innerHTML = S.peers.map((p) => `
    <div class="peer-card">
      <div class="avatar">${initial(p.name)}</div>
      <div class="peer-meta">
        <strong>${esc(p.name)}</strong>
        <span class="muted">${p.shares.length ? `${p.shares.length} 个通道` : '还没有通道'} · ${esc(p.fingerprint || '')}</span>
      </div>
      ${onlineDot(p.online)}
    </div>`).join('');
}

function renderProviderList() {
  const box = $('provider-list');
  if (!S.providers.length) {
    box.innerHTML = '<div class="empty">还没有 API，先在上面添加一个。</div>';
    return;
  }
  box.innerHTML = S.providers.map((p) => `
    <div class="item">
      <div class="item-head">
        <strong>${esc(p.name)}</strong>
        <span class="tag">${p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
        <span class="spacer"></span>
        <button class="ghost small" data-edit-provider="${p.id}">编辑</button>
        <button class="ghost small danger" data-del-provider="${p.id}">删除</button>
      </div>
      <div class="item-sub mono">${esc(p.baseUrl)} · ${esc(p.apiKey)}</div>
    </div>`).join('');
  box.querySelectorAll('[data-edit-provider]').forEach((b) => {
    b.onclick = () => editProvider(b.dataset.editProvider);
  });
  box.querySelectorAll('[data-del-provider]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个 API？用它开的共享通道也会一并删除。')) return;
      try {
        await api('/api/providers/' + b.dataset.delProvider, { method: 'DELETE' });
        await loadAll();
      } catch (err) { toast(err.message, true); }
    };
  });
}

function editProvider(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  S.editingProvider = id;
  $('p-name').value = p.name;
  $('p-proto').value = p.protocol;
  $('p-url').value = p.baseUrl;
  $('p-key').value = '';
  $('p-key').placeholder = '留空表示不修改';
  $('provider-form-title').textContent = '编辑 API';
  $('provider-cancel').classList.remove('hidden');
}

function resetProviderForm() {
  S.editingProvider = null;
  $('p-name').value = '';
  $('p-url').value = '';
  $('p-key').value = '';
  $('p-key').placeholder = 'sk-...';
  $('provider-form-title').textContent = '添加我的 API';
  $('provider-cancel').classList.add('hidden');
}

function fillShareSelects() {
  $('s-provider').innerHTML = S.providers.length
    ? S.providers.map((p) => `<option value="${p.id}">${esc(p.name)}（${p.protocol}）</option>`).join('')
    : '<option value="">先添加 API</option>';
  $('s-consumer').innerHTML = S.peers.length
    ? S.peers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">先配对朋友</option>';
}

function renderShares() {
  fillShareSelects();
  const box = $('share-list');
  if (!S.shares.length) {
    box.innerHTML = '<div class="empty">还没有共享通道。</div>';
    return;
  }
  box.innerHTML = S.shares.map((s) => `
    <div class="item">
      <div class="item-head">
        <strong>${esc(s.name)}</strong>
        <span class="tag">${esc(s.provider ? s.provider.name : '已删除的 API')}</span>
        <span class="tag">${s.consumer ? `${onlineDot(s.consumer.online)} ${esc(s.consumer.name)}` : '—'}</span>
        ${s.enabled ? '' : '<span class="tag off">已停用</span>'}
        <span class="spacer"></span>
        <button class="ghost small" data-copy-share="${s.id}">复制配置</button>
        <button class="ghost small" data-toggle-share="${s.id}">${s.enabled ? '停用' : '启用'}</button>
        <button class="ghost small danger" data-del-share="${s.id}">删除</button>
      </div>
      <div class="item-sub mono">${esc(s.key || '')}</div>
      <div class="usage-line">
        ${progress(s.usageToday, s.dailyTokenLimit)}
        <span>${fmt(s.usageToday)} / ${fmt(s.dailyTokenLimit)} tokens</span>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-copy-share]').forEach((b) => {
    b.onclick = () => {
      const s = S.shares.find((x) => x.id === b.dataset.copyShare);
      copy(snippet(s.provider ? s.provider.protocol : 'anthropic', s.key));
    };
  });
  box.querySelectorAll('[data-toggle-share]').forEach((b) => {
    b.onclick = async () => {
      const s = S.shares.find((x) => x.id === b.dataset.toggleShare);
      try {
        await api('/api/shares/' + s.id, { method: 'PATCH', body: { enabled: !s.enabled } });
        await loadAll();
      } catch (err) { toast(err.message, true); }
    };
  });
  box.querySelectorAll('[data-del-share]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这条共享通道？对方手里的 Key 会立即失效。')) return;
      try {
        await api('/api/shares/' + b.dataset.delShare, { method: 'DELETE' });
        await loadAll();
      } catch (err) { toast(err.message, true); }
    };
  });
}

function renderPeers() {
  renderPeerCards();
  const box = $('peer-list');
  const cards = [];
  for (const peer of S.peers) {
    if (!peer.shares.length) {
      cards.push(`<div class="item"><div class="item-head"><strong>${esc(peer.name)}</strong>${onlineDot(peer.online)}<span class="tag">还没给你开通道</span></div></div>`);
      continue;
    }
    for (const s of peer.shares) {
      const protocol = s.provider ? s.provider.protocol : 'anthropic';
      cards.push(`
        <div class="item">
          <div class="item-head">
            <strong>${esc(peer.name)}</strong>
            ${onlineDot(peer.online)}
            <span class="tag">${esc(s.provider ? s.provider.name : 'API')}</span>
            <span class="tag">${protocol === 'anthropic' ? 'Claude Code' : 'OpenAI / Codex'}</span>
            <span class="spacer"></span>
            <button class="ghost small" data-copy-peer="${s.id}">复制配置</button>
          </div>
          <div class="item-sub mono">${esc(s.key)}</div>
          <div class="usage-line">${progress(s.usageToday, s.dailyTokenLimit)}<span>${fmt(s.usageToday)} / ${fmt(s.dailyTokenLimit)} tokens</span></div>
        </div>`);
    }
  }
  box.innerHTML = cards.join('') || '<div class="empty">还没有配对的朋友。</div>';
  box.querySelectorAll('[data-copy-peer]').forEach((b) => {
    b.onclick = () => {
      for (const peer of S.peers) {
        const s = peer.shares.find((x) => x.id === b.dataset.copyPeer);
        if (s) return copy(snippet(s.provider ? s.provider.protocol : 'anthropic', s.key));
      }
    };
  });
}

function renderUsage() {
  const total = S.shares.reduce((sum, s) => sum + s.usageToday, 0);
  const limit = S.shares.reduce((sum, s) => sum + s.dailyTokenLimit, 0);
  $('usage-total').innerHTML = `${fmt(total)} tokens <small>我提供的通道今天被消耗；总上限 ${fmt(limit)}</small>`;
  $('usage-bars').innerHTML = S.shares.map((s) => `
    <div class="bar-row">
      <span class="name" title="${esc(s.name)}">${esc(s.name)}</span>
      ${progress(s.usageToday, s.dailyTokenLimit)}
      <span>${fmt(s.usageToday)} / ${fmt(s.dailyTokenLimit)}</span>
    </div>`).join('') || '<div class="empty">暂无数据</div>';

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const sum = {};
  for (const s of S.shares) for (const p of s.series || []) sum[p.date] = (sum[p.date] || 0) + p.tokens;
  const max = Math.max(1, ...days.map((d) => sum[d] || 0));
  $('week').innerHTML = days.map((d) => `
    <div class="day">
      <div class="bar" style="height:${Math.max(2, ((sum[d] || 0) / max) * 92)}px" title="${fmt(sum[d] || 0)}"></div>
      <span class="lbl">${d.slice(5)}</span>
    </div>`).join('');

  const names = {};
  for (const s of S.shares) names[s.id] = s.name;
  for (const p of S.peers) for (const s of p.shares) names[s.id] = `${p.name} · ${s.name}`;
  $('log-list').innerHTML = S.requests.length
    ? S.requests.map((r, i) => `
      <div class="log-row" data-log="${i}">
        <span class="muted">${when(r.created_at).slice(5)}</span>
        <span class="${r.status < 400 ? 'ok' : 'bad'}">${r.status}</span>
        <span class="path">${esc(names[r.share_id] || r.path)}</span>
        <span class="muted">${r.model ? esc(String(r.model).slice(0, 16)) : '—'}</span>
        <span>${fmt(r.input_tokens + r.output_tokens)} tok${r.estimated ? '*' : ''}</span>
        <span class="muted">${r.duration_ms}ms</span>
      </div>`).join('')
    : '<div class="empty" style="padding:12px">还没有请求。</div>';
  $('log-list').querySelectorAll('[data-log]').forEach((row) => {
    row.onclick = () => {
      const r = S.requests[Number(row.dataset.log)];
      $('modal-body').textContent = [
        `${when(r.created_at)}  ${r.status}  ${r.path}  ${r.model || ''}`,
        `tokens: in ${r.input_tokens} / out ${r.output_tokens}${r.estimated ? ' (估算)' : ''}  ${r.duration_ms}ms`,
        '',
        '请求与响应由两端加密传输，服务器只保存以上元数据。',
      ].join('\n');
      $('modal').classList.remove('hidden');
    };
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('main > .tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  if (name === 'usage' || name === 'peers') loadAll().catch((err) => toast(err.message, true));
}

function setupCodeInputs() {
  const boxes = [...document.querySelectorAll('#code-inputs input')];
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      digits.split('').forEach((c, j) => { if (boxes[j]) boxes[j].value = c; });
      boxes[Math.min(digits.length, boxes.length - 1)].focus();
    });
  });
}

function wire() {
  $('setup-go').onclick = async () => {
    const relayUrl = $('setup-url').value.trim();
    const name = $('setup-name').value.trim();
    if (!relayUrl || !name) return toast('请填写服务器地址和昵称', true);
    try {
      await api('/api/onboard', { method: 'POST', body: { relayUrl, name } });
      location.reload();
    } catch (err) {
      toast('连接失败：' + err.message, true);
    }
  };

  $('gen-code').onclick = async () => {
    try {
      S.pairCode = await api('/api/pair/code', { method: 'POST' });
      S.codeTtl = Math.max(60000, S.pairCode.expiresAt - Date.now());
      renderCode();
    } catch (err) { toast(err.message, true); }
  };

  $('redeem').onclick = async () => {
    const digits = [...document.querySelectorAll('#code-inputs input')].map((i) => i.value).join('');
    if (digits.length !== 6) return toast('请输入 6 位数字验证码', true);
    try {
      const res = await api('/api/pair/redeem', { method: 'POST', body: { code: digits } });
      toast(`已和 ${res.peer.name} 配对`);
      document.querySelectorAll('#code-inputs input').forEach((i) => { i.value = ''; });
      await loadAll();
    } catch (err) { toast(err.message, true); }
  };

  $('provider-save').onclick = async () => {
    const body = {
      name: $('p-name').value.trim(),
      protocol: $('p-proto').value,
      baseUrl: $('p-url').value.trim(),
      apiKey: $('p-key').value.trim(),
    };
    try {
      if (S.editingProvider) {
        if (!body.apiKey) delete body.apiKey;
        await api('/api/providers/' + S.editingProvider, { method: 'PATCH', body });
      } else {
        await api('/api/providers', { method: 'POST', body });
      }
      resetProviderForm();
      await loadAll();
      toast('已保存');
    } catch (err) { toast(err.message, true); }
  };
  $('provider-cancel').onclick = resetProviderForm;

  $('share-create').onclick = async () => {
    const body = {
      providerId: $('s-provider').value,
      consumerId: $('s-consumer').value || undefined,
      name: $('s-name').value.trim(),
      dailyTokenLimit: Number($('s-limit').value),
    };
    try {
      const created = await api('/api/shares', { method: 'POST', body });
      copy(snippet(created.provider ? created.provider.protocol : 'anthropic', created.key));
      $('s-name').value = '';
      await loadAll();
    } catch (err) { toast(err.message, true); }
  };

  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  $('refresh').onclick = () => loadAll().catch((err) => toast(err.message, true));
  $('modal-close').onclick = () => $('modal').classList.add('hidden');
  $('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };
  setupCodeInputs();
}

wire();
boot().catch((err) => toast(err.message, true));
setInterval(renderCode, 1000);
setInterval(() => {
  if (S.me && !document.hidden) {
    loadAll().catch(() => {});
    api('/api/me').then((me) => { S.me = me; renderStatus(); }).catch(() => {});
  }
}, 20000);
