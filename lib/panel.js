'use strict';

/**
 * The control panel, rendered on the server.
 *
 * Everything here is a plain HTML form. There is no client-side script at all,
 * which is why the pages can ship `script-src 'none'`: the panel displays
 * device names, client names and log details that other people chose, and the
 * cheapest way to be sure none of it executes is for the page to have no script
 * engine to execute it in. Every interpolation goes through `esc`.
 */

const STYLE = `
  :root{--bg:#0b1120;--card:#141d2b;--line:#25303f;--text:#e7eaee;--muted:#8b97a5;--accent:#d3ab68;--ok:#7fb88c;--err:#e97c6e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:var(--accent)}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 64px;display:flex;flex-direction:column;gap:20px}
  h1{font:600 20px/1.2 ui-monospace,Consolas,monospace;margin:0}
  .sub{color:var(--muted);font-size:13px;margin:0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:12px}
  h2{font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0}
  input,select{background:#0b1120;border:1px solid var(--line);border-radius:6px;color:var(--text);padding:9px 12px;font:13px ui-monospace,Consolas,monospace;flex:1;min-width:0}
  button{background:var(--accent);color:#141d2b;border:0;border-radius:6px;padding:9px 16px;font-weight:600;cursor:pointer;font-size:13px}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  button.danger{background:transparent;color:var(--err);border:1px solid var(--line)}
  button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  form{margin:0}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .stat{background:#0b1120;border:1px solid var(--line);border-radius:6px;padding:12px}
  .stat .n{font:700 26px/1.1 ui-monospace,Consolas,monospace}
  .stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
  ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  li{background:#0b1120;border:1px solid var(--line);border-radius:6px;padding:10px 12px;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:4px}
  li .top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}
  li .meta{font-size:11px;color:var(--muted)}
  .s-success{color:var(--ok)} .s-error{color:var(--err)} .s-pending{color:var(--accent)} .s-info{color:var(--muted)}
  .empty{color:var(--muted);font-style:italic;font-size:12px}
  code{color:var(--accent)}
  nav{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;border-bottom:1px solid var(--line);padding-bottom:12px}
  nav a{text-decoration:none;color:var(--muted)}
  nav a.on{color:var(--accent);font-weight:600}
  .banner{border-radius:6px;padding:10px 12px;font-size:13px;border:1px solid var(--line)}
  .banner.err{color:var(--err);border-color:var(--err)}
  .banner.ok{color:var(--ok);border-color:var(--ok)}
  .banner.warn{color:var(--accent);border-color:var(--accent)}
  .pill{font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--line);border-radius:99px;padding:2px 8px;color:var(--muted)}
  .bar{height:6px;background:#0b1120;border:1px solid var(--line);border-radius:99px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--accent)}
  table{width:100%;border-collapse:collapse;font:12px ui-monospace,Consolas,monospace}
  td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
`;

function esc(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function when(ts) {
    if (!ts) return '—';
    try {
        return new Date(Number(ts)).toLocaleString('tr-TR');
    } catch (e) {
        return '—';
    }
}

function layout({ title, nav: navHtml = '', body }) {
    return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${navHtml}
${body}
</div>
</body>
</html>`;
}

function nav(active, email) {
    const link = (href, label, key) =>
        `<a href="${href}"${active === key ? ' class="on"' : ''}>${esc(label)}</a>`;
    return `<nav>
  ${link('/', 'Genel bakış', 'overview')}
  ${link('/audit', 'Denetim kaydı', 'audit')}
  ${link('/account', 'Hesap', 'account')}
  <span style="margin-left:auto;color:var(--muted)">${esc(email)}</span>
</nav>`;
}

function banner(kind, text) {
    if (!text) return '';
    return `<div class="banner ${esc(kind)}">${esc(text)}</div>`;
}

function csrfField(csrf) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
}

// ---------------------------------------------------------------------------

function renderLogin({ mode = 'login', error = '', notice = '', csrf, email = '' }) {
    const isRegister = mode === 'register';
    return layout({
        title: 'MCP Köprü Paneli',
        body: `
  <div>
    <h1>MCP Köprü Paneli</h1>
    <p class="sub">Cihazlarınızı, AI istemcilerinizi ve denetim kaydınızı buradan yönetin.</p>
  </div>
  ${banner('err', error)}
  ${banner('ok', notice)}
  <div class="card">
    <h2>${isRegister ? 'Hesap oluştur' : 'Giriş'}</h2>
    <form method="post" action="${isRegister ? '/auth/register' : '/auth/login'}">
      ${csrfField(csrf)}
      <div class="row" style="flex-direction:column;align-items:stretch">
        <input type="email" name="email" placeholder="e-posta" autocomplete="username" required value="${esc(email)}">
        <input type="password" name="password" placeholder="parola" autocomplete="${isRegister ? 'new-password' : 'current-password'}" required>
        <div class="row">
          <button type="submit">${isRegister ? 'Hesap oluştur' : 'Giriş yap'}</button>
          <a href="${isRegister ? '/login' : '/register'}" class="sub">${isRegister ? 'Zaten hesabım var' : 'Hesabım yok, oluştur'}</a>
        </div>
      </div>
    </form>
  </div>
  <div class="card">
    <h2>Nasıl bağlanır</h2>
    <p class="sub">1 · Android uygulamasında <b>Ayarlar → MCP → Hesaba bağla</b> ile bir kod alın.</p>
    <p class="sub">2 · Kodu bu panelde girin; cihaz hesabınıza bağlanır.</p>
    <p class="sub">3 · Uygulamada bir AI istemcisi ekleyin ve verilen <code>Authorization: Bearer &lt;clientId&gt;.&lt;secret&gt;</code> başlığını MCP yapılandırmanıza yazın.</p>
  </div>`
    });
}

function renderOverview(model) {
    const {
        account, plan, devices, clients, connectedDeviceIds, openSessions,
        usage, csrf, error = '', notice = '', unclaimedHint = false, storeWarning = ''
    } = model;

    const connected = new Set(connectedDeviceIds || []);
    const usedPercent = plan.commandsPerDay > 0
        ? Math.min(100, Math.round((usage.commandCount / plan.commandsPerDay) * 100))
        : 0;

    const deviceItems = devices.length ? devices.map((d) => {
        const isOnline = connected.has(d.id);
        const owned = clients.filter((c) => c.deviceId === d.id).length;
        return `<li>
      <div class="top">
        <span>${esc(d.name || d.id)}</span>
        <span class="pill ${isOnline ? 's-success' : ''}">${isOnline ? 'çevrimiçi' : 'çevrimdışı'}</span>
      </div>
      <div class="meta">${esc(d.id)} · ${owned} istemci · son görülme ${esc(when(d.lastSeenAt))}</div>
      <form method="post" action="/devices/release" class="row">
        ${csrfField(csrf)}
        <input type="hidden" name="deviceId" value="${esc(d.id)}">
        <button type="submit" class="danger">Bağı kopar</button>
      </form>
    </li>`;
    }).join('') : '<li class="empty">Henüz bağlı cihaz yok. Aşağıdaki kutuya telefondan aldığınız kodu girin.</li>';

    const clientItems = clients.length ? clients.map((c) => `<li>
      <div class="top">
        <span>${esc(c.name)}</span>
        <span class="pill">${esc(c.id.substring(0, 12))}</span>
      </div>
      <div class="meta">cihaz ${esc(c.deviceId)} · eklendi ${esc(when(c.createdAt))}</div>
      <form method="post" action="/clients/revoke" class="row">
        ${csrfField(csrf)}
        <input type="hidden" name="clientId" value="${esc(c.id)}">
        <button type="submit" class="danger">Erişimi iptal et</button>
      </form>
    </li>`).join('') : '<li class="empty">Bu hesaba bağlı AI istemcisi yok.</li>';

    return layout({
        title: 'Genel bakış · MCP Köprü Paneli',
        nav: nav('overview', account.email),
        body: `
  ${banner('warn', storeWarning)}
  ${banner('err', error)}
  ${banner('ok', notice)}
  ${unclaimedHint ? banner('warn', 'Bu röleye bağlı, hiçbir hesaba ait olmayan cihazlar var. Telefonunuzdan kod alıp aşağıya girerek sahiplenin.') : ''}

  <div class="card">
    <h2>Durum · ${esc(plan.label)} plan</h2>
    <div class="grid">
      <div class="stat"><div class="n">${devices.length}</div><div class="l">Cihaz / ${esc(plan.maxDevices)}</div></div>
      <div class="stat"><div class="n">${clients.length}</div><div class="l">AI istemcisi</div></div>
      <div class="stat"><div class="n">${esc(openSessions)}</div><div class="l">Açık MCP kanalı</div></div>
      <div class="stat"><div class="n">${esc(usage.commandCount)}</div><div class="l">Bugünkü komut</div></div>
    </div>
    <div class="bar"><i style="width:${usedPercent}%"></i></div>
    <p class="sub">Günlük kota: ${esc(usage.commandCount)} / ${esc(plan.commandsPerDay)} komut. Denetim kaydı ${esc(plan.auditRetentionDays)} gün saklanır.</p>
  </div>

  <div class="card">
    <h2>Cihaz bağla</h2>
    <form method="post" action="/devices/claim" class="row">
      ${csrfField(csrf)}
      <input name="code" placeholder="telefondaki kod" autocomplete="off" maxlength="16" required>
      <button type="submit">Bağla</button>
    </form>
    <p class="sub">Android uygulamasında <b>Ayarlar → MCP → Hesaba bağla</b> deyin; ekranda çıkan kodu 10 dakika içinde buraya girin.</p>
  </div>

  <div class="card">
    <h2>Cihazlar</h2>
    <ul>${deviceItems}</ul>
  </div>

  <div class="card">
    <h2>AI istemcileri</h2>
    <ul>${clientItems}</ul>
    <p class="sub">Anahtar üretimi telefonda kalır: röle düz metin sırrı hiç görmez, bu yüzden panel bir anahtarı gösteremez. İptal ise anında etkilidir.</p>
  </div>`
    });
}

function renderAudit({ account, events, devices, clients, filters, plan }) {
    const options = (items, selected, labelOf, valueOf) =>
        items.map((i) => `<option value="${esc(valueOf(i))}"${selected === valueOf(i) ? ' selected' : ''}>${esc(labelOf(i))}</option>`).join('');

    const rows = events.length ? events.map((e) => `<tr>
      <td class="meta">${esc(when(e.createdAt))}</td>
      <td class="s-${esc(e.status)}">${esc(e.status)}</td>
      <td>${esc(e.action)}</td>
      <td class="meta">${esc(e.clientId ? e.clientId.substring(0, 12) : '—')}</td>
      <td class="meta">${esc(e.host || '')} ${esc(e.detail || '')}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Kayıt yok.</td></tr>';

    return layout({
        title: 'Denetim kaydı · MCP Köprü Paneli',
        nav: nav('audit', account.email),
        body: `
  <div class="card">
    <h2>Süzgeç</h2>
    <form method="get" action="/audit" class="row">
      <select name="deviceId">
        <option value="">tüm cihazlar</option>
        ${options(devices, filters.deviceId, (d) => d.name || d.id, (d) => d.id)}
      </select>
      <select name="clientId">
        <option value="">tüm istemciler</option>
        ${options(clients, filters.clientId, (c) => c.name, (c) => c.id)}
      </select>
      <button type="submit">Uygula</button>
      <a href="/audit/export" class="sub">CSV indir</a>
    </form>
    <p class="sub">Kayıtlar ${esc(plan.auditRetentionDays)} gün saklanır. İçerik, tam adres ve sır asla yazılmaz — yalnızca araç adı, sonuç ve host.</p>
  </div>

  <div class="card">
    <h2>Olaylar</h2>
    <table>
      <tr><th>Zaman</th><th>Durum</th><th>Eylem</th><th>İstemci</th><th>Ayrıntı</th></tr>
      ${rows}
    </table>
  </div>`
    });
}

function renderAccount({ account, plan, csrf, error = '', notice = '', activeSessions }) {
    return layout({
        title: 'Hesap · MCP Köprü Paneli',
        nav: nav('account', account.email),
        body: `
  ${banner('err', error)}
  ${banner('ok', notice)}

  <div class="card">
    <h2>Hesap</h2>
    <p class="sub">E-posta: <code>${esc(account.email)}</code></p>
    <p class="sub">Plan: <code>${esc(plan.label)}</code> · ${esc(plan.maxDevices)} cihaz, günlük ${esc(plan.commandsPerDay)} komut, ${esc(plan.auditRetentionDays)} günlük kayıt.</p>
    <p class="sub">Açık panel oturumu: ${esc(activeSessions)}</p>
  </div>

  <div class="card">
    <h2>Parola değiştir</h2>
    <form method="post" action="/account/password" class="row" style="flex-direction:column;align-items:stretch">
      ${csrfField(csrf)}
      <input type="password" name="current" placeholder="mevcut parola" autocomplete="current-password" required>
      <input type="password" name="next" placeholder="yeni parola" autocomplete="new-password" required>
      <div class="row"><button type="submit">Değiştir</button></div>
    </form>
    <p class="sub">Parola değiştiğinde diğer tüm panel oturumları kapatılır. AI istemci anahtarları etkilenmez — onlar telefondan yönetilir.</p>
  </div>

  <div class="card">
    <h2>Oturumlar</h2>
    <form method="post" action="/account/sessions/revoke" class="row">
      ${csrfField(csrf)}
      <button type="submit" class="danger">Diğer tüm oturumları kapat</button>
    </form>
  </div>

  <div class="card">
    <h2>Çıkış</h2>
    <form method="post" action="/auth/logout" class="row">
      ${csrfField(csrf)}
      <button type="submit" class="ghost">Çıkış yap</button>
    </form>
  </div>`
    });
}

function renderMessage({ title, heading, text, linkHref = '/', linkText = 'Panele dön' }) {
    return layout({
        title,
        body: `
  <div class="card">
    <h2>${esc(heading)}</h2>
    <p class="sub">${esc(text)}</p>
    <p><a href="${esc(linkHref)}">${esc(linkText)}</a></p>
  </div>`
    });
}

module.exports = {
    esc,
    when,
    renderLogin,
    renderOverview,
    renderAudit,
    renderAccount,
    renderMessage
};
