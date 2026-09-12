'use strict';

/**
 * The operator console, rendered on the server.
 *
 * This is not where users live. Signing up, signing in, settings, permissions
 * and the audit trail all happen in the Android app; nobody is sent to a
 * website to run their own browser. What is left here is the view whoever runs
 * the relay needs: how many accounts, devices and commands there are, and the
 * ability to suspend an account that is being abused.
 *
 * Deliberately absent: another account's audit trail. An operator managing
 * users needs counts and status, not the list of hosts somebody's phone
 * visited. `/audit` stays scoped to the signed-in operator's own account.
 *
 * Everything here is a plain HTML form. There is no client-side script at all,
 * which is why the pages can ship `script-src 'none'`: the panel displays
 * device names, client names and log details that other people chose, and the
 * cheapest way to be sure none of it executes is for the page to have no script
 * engine to execute it in. Every interpolation goes through `esc`.
 */

const STYLE = `
  :root{--bg:#08101d;--panel:#0d1726;--card:#121f31;--soft:#17263a;--line:#26384f;--text:#eef4fb;--muted:#92a3b7;--accent:#64d8cb;--accent-ink:#06211f;--ok:#78d69a;--err:#ff8c84;--warn:#f4c56a}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(circle at 80% 0,#102b39 0,transparent 32%),var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
  a{color:var(--accent)}
  .shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}
  .sidebar{background:rgba(9,18,31,.96);border-right:1px solid var(--line);padding:24px 16px;display:flex;flex-direction:column;gap:24px;position:sticky;top:0;height:100vh}
  .brand{display:flex;align-items:center;gap:10px;padding:0 8px}.brand-mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),#5b8fff);display:grid;place-items:center;color:var(--accent-ink);font-weight:900}.brand-copy strong{display:block}.brand-copy span{color:var(--muted);font-size:11px}
  nav{display:flex;flex-direction:column;gap:6px}nav a{text-decoration:none;color:var(--muted);padding:10px 12px;border-radius:9px;font-weight:600}nav a:hover{background:var(--soft);color:var(--text)}nav a.on{background:rgba(100,216,203,.12);color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
  .admin-id{margin-top:auto;border-top:1px solid var(--line);padding:16px 8px 0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.admin-id strong{display:block;color:var(--text);font-size:12px;margin-bottom:3px}
  .wrap{width:100%;max-width:1320px;margin:0 auto;padding:34px 34px 72px;display:flex;flex-direction:column;gap:20px}
  .login-wrap{max-width:470px;margin:0 auto;padding:9vh 20px 60px;display:flex;flex-direction:column;gap:20px}
  .page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}.page-head h1{margin-bottom:6px}
  h1{font:700 26px/1.15 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;letter-spacing:-.02em}
  h2{font:700 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin:0}
  h3{font-size:15px;margin:0}.sub{color:var(--muted);font-size:13px;margin:0}.eyebrow{color:var(--accent);font:700 11px ui-monospace,Consolas,monospace;letter-spacing:.13em;text-transform:uppercase;margin:0 0 7px}
  .card{background:linear-gradient(180deg,rgba(18,31,49,.98),rgba(13,23,38,.98));border:1px solid var(--line);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 42px rgba(0,0,0,.14)}
  .card.compact{padding:16px}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
  input,select,textarea{background:var(--bg);border:1px solid var(--line);border-radius:9px;color:var(--text);padding:10px 12px;font:13px ui-monospace,Consolas,monospace;flex:1;min-width:0}
  textarea{width:100%;min-height:72px;resize:vertical}input::placeholder{color:#65778d}
  button,.button{background:var(--accent);color:var(--accent-ink);border:1px solid transparent;border-radius:9px;padding:10px 15px;font-weight:750;cursor:pointer;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px}
  button.ghost,.button.ghost{background:transparent;color:var(--text);border-color:var(--line)}button.danger,.button.danger{background:rgba(255,140,132,.08);color:var(--err);border-color:rgba(255,140,132,.35)}
  button:hover,.button:hover{filter:brightness(1.08)}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  form{margin:0}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px}.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat{background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:15px}.stat .n{font:750 28px/1.1 ui-monospace,Consolas,monospace}.stat .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:5px}.stat .hint{font-size:11px;color:var(--muted);margin-top:8px}
  ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}li{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:11px 13px;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:5px}li .top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}li .meta,.meta{font-size:11px;color:var(--muted)}
  .s-success{color:var(--ok)}.s-error{color:var(--err)}.s-pending{color:var(--warn)}.s-info{color:var(--muted)}.empty{color:var(--muted);font-style:italic;font-size:12px}code{color:var(--accent)}
  .field{display:flex;flex-direction:column;gap:5px;min-width:150px;flex:1}.field.wide{flex-basis:100%}.field label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  .banner{border-radius:10px;padding:11px 14px;font-size:13px;border:1px solid var(--line);background:var(--panel)}.banner.err{color:var(--err);border-color:rgba(255,140,132,.5)}.banner.ok{color:var(--ok);border-color:rgba(120,214,154,.45)}.banner.warn{color:var(--warn);border-color:rgba(244,197,106,.45)}
  .pill{display:inline-flex;align-items:center;font-size:10px;letter-spacing:.07em;text-transform:uppercase;border:1px solid var(--line);border-radius:99px;padding:3px 8px;color:var(--muted);white-space:nowrap}.pill.ok{color:var(--ok);border-color:rgba(120,214,154,.35)}.pill.err{color:var(--err);border-color:rgba(255,140,132,.35)}.pill.pro{color:var(--accent);border-color:rgba(100,216,203,.35)}
  .bar{height:7px;background:var(--bg);border:1px solid var(--line);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#5b8fff)}
  .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;font:12px ui-monospace,Consolas,monospace;min-width:760px}td,th{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:middle}tr:last-child td{border-bottom:0}tbody tr:hover{background:rgba(100,216,203,.035)}th{background:var(--bg);color:var(--muted);font-weight:650;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.account-link{font-weight:700;text-decoration:none;color:var(--text)}.account-link:hover{color:var(--accent)}
  .detail-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:20px}.definition{display:grid;grid-template-columns:150px minmax(0,1fr);gap:9px 16px;margin:0}.definition dt{color:var(--muted)}.definition dd{margin:0;overflow-wrap:anywhere}
  .danger-zone{border-color:rgba(255,140,132,.38)}.login-card{padding:28px}.login-brand{display:flex;align-items:center;gap:12px;margin-bottom:4px}
  @media(max-width:860px){.shell{display:block}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:15px 18px;gap:14px}.sidebar nav{flex-direction:row;overflow:auto}.sidebar nav a{white-space:nowrap}.admin-id{display:none}.wrap{padding:24px 16px 60px}.detail-grid,.grid.two{grid-template-columns:1fr}}
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
    const content = `<main class="${navHtml ? 'wrap' : 'login-wrap'}">${body}</main>`;
    return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${navHtml ? `<div class="shell">${navHtml}${content}</div>` : content}
</body>
</html>`;
}

function nav(active, email) {
    const link = (href, label, key) =>
        `<a href="${href}"${active === key ? ' class="on"' : ''}>${esc(label)}</a>`;
    return `<aside class="sidebar">
  <div class="brand"><div class="brand-mark">M</div><div class="brand-copy"><strong>MCP Bridge</strong><span>Yönetim Merkezi</span></div></div>
  <nav>
    ${link('/', 'Genel Bakış', 'overview')}
    ${link('/admin/users', 'Kullanıcılar', 'users')}
    ${link('/admin/quick-links', 'Hızlı Linkler', 'quick-links')}
    ${link('/audit', 'Kendi Denetim Kaydım', 'audit')}
    ${link('/account', 'Yönetici Hesabı', 'account')}
  </nav>
  <div class="admin-id"><strong>Yönetici</strong>${esc(email)}</div>
</aside>`;
}

function quickLinkCategoryOptions(categories, selectedId = '') {
    return categories.map((category) =>
        `<option value="${esc(category.id)}"${category.id === selectedId ? ' selected' : ''}>${esc(category.title)}</option>`
    ).join('');
}

function quickLinkSiteFields(link = {}, categories = []) {
    return `
      <div class="field"><label>Kategori</label><select name="categoryId" required>${quickLinkCategoryOptions(categories, link.categoryId || '')}</select></div>
      <div class="field"><label>Site adı</label><input name="name" maxlength="80" required value="${esc(link.name || '')}" placeholder="Skyscanner"></div>
      <div class="field"><label>Site sırası</label><input name="sortOrder" type="number" min="0" max="9999" required value="${esc(link.sortOrder ?? 0)}"></div>
      <div class="field wide"><label>Bağlantı — affiliate parametreleriyle birlikte</label><input name="url" type="url" maxlength="2048" required value="${esc(link.url || '')}" placeholder="https://..."></div>
      <div class="field wide"><label>AI için kısa açıklama</label><textarea name="description" maxlength="240" required placeholder="Örn. Tarih ve rota bazında uçuş fiyatlarını karşılaştırmak için.">${esc(link.description || '')}</textarea><span class="sub">Yalnızca AI'nin kısayol listesinde görünür; uygulamanın hızlı-link kartlarında gösterilmez.</span></div>
      <div class="field"><label>Durum</label><select name="active"><option value="1"${link.active !== false ? ' selected' : ''}>Yayında</option><option value="0"${link.active === false ? ' selected' : ''}>Gizli</option></select></div>`;
}

function renderQuickLinks({ account, catalogue, categories, csrf, error = '', notice = '' }) {
    const totalOpens = catalogue.links.reduce((sum, link) => sum + Number(link.openCount || 0), 0);
    const categoryManagement = categories.map((category) => `
    <div class="stat">
      <form method="post" action="/admin/quick-links/categories/save" class="row">
        ${csrfField(csrf)}
        <input type="hidden" name="id" value="${esc(category.id)}">
        <div class="field"><label>Kategori adı</label><input name="title" maxlength="60" required value="${esc(category.title)}"></div>
        <div class="field"><label>Gösterim sırası</label><input name="sortOrder" type="number" min="0" max="9999" required value="${esc(category.sortOrder)}"></div>
        <button type="submit">Kategoriyi kaydet</button>
      </form>
      <div class="row" style="justify-content:space-between;margin-top:10px">
        <span class="sub">${esc(category.siteCount)} site · ${esc(category.openCount)} açılış</span>
        <form method="post" action="/admin/quick-links/categories/delete">
          ${csrfField(csrf)}
          <input type="hidden" name="id" value="${esc(category.id)}">
          <button type="submit" class="danger">Kategoriyi sil</button>
        </form>
      </div>
    </div>`).join('');

    const groupedSites = categories.map((category) => {
        const links = catalogue.links.filter((link) => link.categoryId === category.id);
        const siteCards = links.length ? links.map((link) => `
      <div class="stat">
        <div class="row" style="justify-content:space-between">
          <h2>${esc(link.name)}</h2>
          <div class="row">
            <span class="pill">${esc(link.openCount || 0)} açılış</span>
            <span class="pill ${link.active ? 's-success' : 's-pending'}">${link.active ? 'yayında' : 'gizli'}</span>
          </div>
        </div>
        <p class="sub">Son açılış: ${esc(when(link.lastOpenedAt))}</p>
        <form method="post" action="/admin/quick-links/save" class="row">
          ${csrfField(csrf)}
          <input type="hidden" name="id" value="${esc(link.id)}">
          ${quickLinkSiteFields(link, categories)}
          <button type="submit">Siteyi kaydet</button>
        </form>
        <form method="post" action="/admin/quick-links/delete" class="row" style="margin-top:10px">
          ${csrfField(csrf)}
          <input type="hidden" name="id" value="${esc(link.id)}">
          <button type="submit" class="danger">Kalıcı olarak sil</button>
          <span class="sub">Silmeden kaldırmak için durumu “Gizli” yapın.</span>
        </form>
      </div>`).join('') : '<p class="empty">Bu kategoride henüz site yok.</p>';
        return `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h2>${esc(category.title)}</h2>
      <span class="sub">${esc(links.length)} site · ${esc(category.openCount)} açılış</span>
    </div>
    ${siteCards}
  </div>`;
    }).join('');

    return layout({
        title: 'Hızlı Linkler · MCP Köprü Paneli',
        nav: nav('quick-links', account.email),
        body: `
  <div>
    <h1>Hızlı Linkler</h1>
    <p class="sub">Sürüm ${esc(catalogue.revision)} · ${esc(catalogue.links.length)} site · ${esc(totalOpens)} toplam açılış</p>
  </div>
  ${banner('err', error)}
  ${banner('ok', notice)}
  <div class="card">
    <h2>1 · Kategori yönetimi</h2>
    <p class="sub">Kategorileri burada bağımsız olarak ekleyin, yeniden adlandırın ve sıralayın. İçinde site bulunan kategori silinmez.</p>
    <form method="post" action="/admin/quick-links/categories/save" class="row">
      ${csrfField(csrf)}
      <div class="field"><label>Yeni kategori adı</label><input name="title" maxlength="60" required placeholder="Uçuş"></div>
      <div class="field"><label>Gösterim sırası</label><input name="sortOrder" type="number" min="0" max="9999" required value="0"></div>
      <button type="submit">Kategori ekle</button>
    </form>
    <div class="grid">${categoryManagement || '<p class="empty">Henüz kategori yok.</p>'}</div>
  </div>
  <div class="card">
    <h2>2 · Yeni site ekle</h2>
    <p class="sub">AI bu sitelerle sınırlanmaz. Bir kısayolu seçtiğinde, kayıtlı adres affiliate parametreleri korunarak cihaz tarafında aynen açılır.</p>
    ${categories.length ? `<form method="post" action="/admin/quick-links/save" class="row">
      ${csrfField(csrf)}
      ${quickLinkSiteFields({ active: true, categoryId: categories[0].id, sortOrder: 0 }, categories)}
      <button type="submit">Siteyi ekle</button>
    </form>` : '<p class="empty">Site eklemeden önce bir kategori oluşturun.</p>'}
  </div>
  <div><h1>3 · Kategorilere göre siteler</h1><p class="sub">Açılış sayıları, bağlı uygulamada kullanıcı veya AI tarafından hızlı link üzerinden gerçekten açılan kayıtları gösterir. Adres ve affiliate parametreleri analitik kaydına alınmaz.</p></div>
  ${groupedSites || '<div class="card"><p class="empty">Katalog boş.</p></div>'}`
    });
}

function banner(kind, text) {
    if (!text) return '';
    return `<div class="banner ${esc(kind)}">${esc(text)}</div>`;
}

function csrfField(csrf) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
}

// ---------------------------------------------------------------------------

function renderLogin({ error = '', notice = '', csrf, email = '' }) {
    return layout({
        title: 'Yönetici Girişi · MCP Bridge',
        body: `
  ${banner('err', error)}
  ${banner('ok', notice)}
  <div class="card login-card">
    <div class="login-brand"><div class="brand-mark">M</div><div><p class="eyebrow">Güvenli Yönetim</p><h1>MCP Bridge</h1></div></div>
    <p class="sub">Sunucu yönetim merkezine yalnızca yetkilendirilmiş yönetici hesapları giriş yapabilir.</p>
    <form method="post" action="/auth/login" class="stack">
      ${csrfField(csrf)}
      <div class="field"><label>Yönetici e-postası</label><input type="email" name="email" placeholder="admin@example.com" autocomplete="username" required autofocus value="${esc(email)}"></div>
      <div class="field"><label>Parola</label><input type="password" name="password" placeholder="••••••••••••" autocomplete="current-password" required></div>
      <button type="submit">Yönetim Merkezine Gir</button>
    </form>
  </div>
  <p class="sub" style="text-align:center">Kullanıcı hesapları Android uygulamasından yönetilir. Bu sayfada hesap kaydı yapılmaz.</p>`
    });
}

function renderOperatorOverview(model) {
    const {
        account, totals, breakdown, recentAccounts, usageByAccount,
        openChannels, quickLinks, error = '', notice = '', storeWarning = '', registrationOpen
    } = model;

    const recentRows = recentAccounts.length ? recentAccounts.map((a) => `<tr>
      <td><a class="account-link" href="/admin/users/${esc(a.id)}">${esc(a.email)}</a>${a.isAdmin ? ' <span class="pill">yönetici</span>' : ''}</td>
      <td><span class="pill ${a.plan === 'pro' ? 'pro' : ''}">${esc(a.plan)}</span></td>
      <td><span class="pill ${a.status === 'active' ? 'ok' : 'err'}">${a.status === 'active' ? 'aktif' : 'askıda'}</span></td>
      <td>${esc(a.deviceCount)}</td><td>${esc(a.clientCount)}</td><td>${esc(usageByAccount.get(a.id) || 0)}</td>
      <td class="meta">${esc(when(a.createdAt))}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Henüz hesap yok.</td></tr>';

    return layout({
        title: 'Genel Bakış · MCP Bridge',
        nav: nav('overview', account.email),
        body: `
  <div class="page-head"><div><p class="eyebrow">Yönetim Merkezi</p><h1>Genel Bakış</h1><p class="sub">Rölenin güncel durumu ve temel kullanım göstergeleri.</p></div><a class="button" href="/admin/users">Kullanıcıları Yönet</a></div>
  ${banner('warn', storeWarning)}
  ${registrationOpen ? banner('warn', 'Uygulama üzerinden yeni kullanıcı kaydı açık. Kapatmak için ALLOW_REGISTRATION=false ayarlayın.') : ''}
  ${banner('err', error)}
  ${banner('ok', notice)}

  <div class="card">
    <div class="card-head"><h2>Canlı Sistem Özeti</h2><span class="pill ok">Çalışıyor</span></div>
    <div class="grid">
      <div class="stat"><div class="n">${esc(totals.accounts)}</div><div class="l">Toplam Kullanıcı</div><div class="hint">${esc(breakdown.active)} aktif · ${esc(breakdown.suspended)} askıda</div></div>
      <div class="stat"><div class="n">${esc(totals.devices)}</div><div class="l">Kayıtlı Cihaz</div><div class="hint">${esc(totals.unclaimedDevices)} sahipsiz cihaz</div></div>
      <div class="stat"><div class="n">${esc(totals.clients)}</div><div class="l">AI Oturumu</div><div class="hint">Tüm hesaplar toplamı</div></div>
      <div class="stat"><div class="n">${esc(openChannels)}</div><div class="l">Açık MCP Kanalı</div><div class="hint">Şu anda bağlı</div></div>
      <div class="stat"><div class="n">${esc(totals.commandsToday)}</div><div class="l">Bugünkü Komut</div><div class="hint">UTC günlük pencere</div></div>
      <div class="stat"><div class="n">${esc(breakdown.pro)}</div><div class="l">Pro Kullanıcı</div><div class="hint">${esc(breakdown.free)} ücretsiz hesap</div></div>
    </div>
  </div>

  <div class="grid two">
    <div class="card"><div class="card-head"><h2>Kullanıcı Dağılımı</h2><a href="/admin/users" class="sub">Tümünü gör →</a></div><div class="grid two"><div class="stat"><div class="n">${esc(breakdown.free)}</div><div class="l">Free</div></div><div class="stat"><div class="n">${esc(breakdown.pro)}</div><div class="l">Pro</div></div></div></div>
    <div class="card"><div class="card-head"><h2>Hızlı Link Kataloğu</h2><a href="/admin/quick-links" class="sub">Düzenle →</a></div><div class="grid two"><div class="stat"><div class="n">${esc(quickLinks.sites)}</div><div class="l">Site</div></div><div class="stat"><div class="n">${esc(quickLinks.opens)}</div><div class="l">Toplam Açılış</div></div></div><p class="sub">${esc(quickLinks.categories)} kategori · katalog sürümü ${esc(quickLinks.revision)}</p></div>
  </div>

  <div class="card">
    <div class="card-head"><div><h2>Son Kaydolan Kullanıcılar</h2><p class="sub">Hızlı inceleme için en yeni hesaplar.</p></div><a class="button ghost" href="/admin/users">Kullanıcı listesi</a></div>
    <div class="table-wrap"><table><thead><tr><th>E-posta</th><th>Plan</th><th>Durum</th><th>Cihaz</th><th>AI Oturumu</th><th>Bugün</th><th>Kayıt</th></tr></thead><tbody>${recentRows}</tbody></table></div>
    <p class="sub">Gizlilik gereği başka hesapların site geçmişi ve denetim kayıtları yönetici panelinde gösterilmez.</p>
  </div>`
    });
}

function renderUsers({ account, accounts: rows, usageByAccount, filters, csrf, error = '', notice = '' }) {
    const tableRows = rows.length ? rows.map((a) => `<tr>
      <td><a class="account-link" href="/admin/users/${esc(a.id)}">${esc(a.email)}</a>${a.isAdmin ? ' <span class="pill">yönetici</span>' : ''}</td>
      <td><span class="pill ${a.plan === 'pro' ? 'pro' : ''}">${esc(a.plan)}</span></td>
      <td><span class="pill ${a.status === 'active' ? 'ok' : 'err'}">${a.status === 'active' ? 'aktif' : 'askıda'}</span></td>
      <td>${esc(a.deviceCount)}</td><td>${esc(a.clientCount)}</td><td>${esc(usageByAccount.get(a.id) || 0)}</td>
      <td class="meta">${esc(when(a.createdAt))}</td><td><a class="button ghost" href="/admin/users/${esc(a.id)}">Yönet</a></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">Bu filtrelerle eşleşen kullanıcı yok.</td></tr>';

    return layout({
        title: 'Kullanıcılar · MCP Bridge',
        nav: nav('users', account.email),
        body: `
  <div class="page-head"><div><p class="eyebrow">Hesap Yönetimi</p><h1>Kullanıcılar</h1><p class="sub">Plan, durum ve kullanım özetlerini tek yerden yönetin.</p></div><span class="pill">${esc(rows.length)} sonuç</span></div>
  ${banner('err', error)}${banner('ok', notice)}
  <div class="card compact">
    <form method="get" action="/admin/users" class="row">
      <div class="field"><label>E-posta ara</label><input type="search" name="q" maxlength="120" placeholder="kullanici@example.com" value="${esc(filters.q)}"></div>
      <div class="field"><label>Plan</label><select name="plan"><option value="">Tüm planlar</option><option value="free"${filters.plan === 'free' ? ' selected' : ''}>Free</option><option value="pro"${filters.plan === 'pro' ? ' selected' : ''}>Pro</option></select></div>
      <div class="field"><label>Durum</label><select name="status"><option value="">Tüm durumlar</option><option value="active"${filters.status === 'active' ? ' selected' : ''}>Aktif</option><option value="suspended"${filters.status === 'suspended' ? ' selected' : ''}>Askıda</option></select></div>
      <div class="actions" style="align-self:flex-end"><button type="submit">Filtrele</button><a class="button ghost" href="/admin/users">Temizle</a></div>
    </form>
  </div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Kullanıcı</th><th>Plan</th><th>Durum</th><th>Cihaz</th><th>AI Oturumu</th><th>Bugün</th><th>Kayıt</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div><p class="sub">Sonuçlar en yeni hesaptan eskiye sıralanır. Başka kullanıcıların denetim ayrıntıları bu panelde açılmaz.</p></div>`
    });
}

function renderUserDetail({ account, target, usage, activeSessions, csrf, error = '', notice = '' }) {
    const suspended = target.status !== 'active';
    const isSelf = target.id === account.id;
    return layout({
        title: `${target.email} · MCP Bridge`,
        nav: nav('users', account.email),
        body: `
  <div class="page-head"><div><p class="eyebrow"><a href="/admin/users">Kullanıcılar</a> / Hesap</p><h1>${esc(target.email)}</h1><div class="actions"><span class="pill ${target.plan === 'pro' ? 'pro' : ''}">${esc(target.plan)}</span><span class="pill ${suspended ? 'err' : 'ok'}">${suspended ? 'askıda' : 'aktif'}</span>${target.isAdmin ? '<span class="pill">yönetici</span>' : ''}</div></div><a class="button ghost" href="/admin/users">← Listeye dön</a></div>
  ${banner('err', error)}${banner('ok', notice)}
  <div class="detail-grid">
    <div class="stack">
      <div class="card"><h2>Hesap Özeti</h2><dl class="definition"><dt>Hesap kimliği</dt><dd><code>${esc(target.id)}</code></dd><dt>Kayıt tarihi</dt><dd>${esc(when(target.createdAt))}</dd><dt>Bugünkü komut</dt><dd>${esc(usage)}</dd><dt>Kayıtlı cihaz</dt><dd>${esc(target.deviceCount)}</dd><dt>AI oturumu</dt><dd>${esc(target.clientCount)}</dd><dt>Açık panel oturumu</dt><dd>${esc(activeSessions)}</dd></dl></div>
      <div class="card"><h2>Plan Yönetimi</h2><p class="sub">Plan değişikliği cihaz ve günlük komut sınırlarını anında günceller.</p><form method="post" action="/admin/accounts/plan" class="row">${csrfField(csrf)}<input type="hidden" name="accountId" value="${esc(target.id)}"><select name="plan"><option value="free"${target.plan === 'free' ? ' selected' : ''}>Free</option><option value="pro"${target.plan === 'pro' ? ' selected' : ''}>Pro</option></select><button type="submit">Planı Kaydet</button></form></div>
      <div class="card"><h2>Kullanıcı Parolasını Sıfırla</h2><p class="sub">Yeni parola en az 12 karakter olmalı. Güvenlik için kendi yönetici parolanızla işlemi onaylayın. Hesapta uçtan uca şifreli çerez veya anahtar paketi varsa veri anahtarını kaybetmemek için sıfırlama reddedilir.</p>${isSelf ? '<div class="banner warn">Kendi parolanızı Yönetici Hesabı bölümünden değiştirin.</div>' : `<form method="post" action="/admin/users/${esc(target.id)}/password" class="stack">${csrfField(csrf)}<div class="field"><label>Yeni kullanıcı parolası</label><input type="password" name="next" autocomplete="new-password" minlength="12" required></div><div class="field"><label>Yeni parolayı doğrula</label><input type="password" name="confirm" autocomplete="new-password" minlength="12" required></div><div class="field"><label>Yönetici parolanız</label><input type="password" name="operatorPassword" autocomplete="current-password" required></div><div><button type="submit">Parolayı Sıfırla</button></div></form>`}</div>
    </div>
    <div class="stack">
      <div class="card"><h2>Durum Yönetimi</h2><p class="sub">Askıya alma, kullanıcının yeni komutlarını durdurur ve açık MCP/panel kanallarını kapatır.</p>${isSelf ? '<div class="banner warn">Kendi yönetici hesabınızı askıya alamazsınız.</div>' : `<form method="post" action="/admin/accounts/status" class="stack">${csrfField(csrf)}<input type="hidden" name="accountId" value="${esc(target.id)}"><input type="hidden" name="status" value="${suspended ? 'active' : 'suspended'}"><button type="submit" class="${suspended ? '' : 'danger'}">${suspended ? 'Hesabı Aktifleştir' : 'Hesabı Askıya Al'}</button></form>`}</div>
      <div class="card danger-zone"><h2>Oturum Güvenliği</h2><p class="sub">Kullanıcının açık web paneli oturumlarını kapatır. Telefonlardaki MCP anahtarları silinmez.</p>${isSelf ? '<p class="sub">Kendi oturumlarınızı Yönetici Hesabı bölümünden yönetin.</p>' : `<form method="post" action="/admin/users/${esc(target.id)}/sessions/revoke">${csrfField(csrf)}<button type="submit" class="danger">Tüm Panel Oturumlarını Kapat</button></form>`}</div>
      <div class="card"><h2>Gizlilik Sınırı</h2><p class="sub">Yönetici; planı, durumu ve sayaçları yönetebilir. Kullanıcının gezdiği siteler, form içerikleri ve denetim ayrıntıları burada gösterilmez.</p></div>
    </div>
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

function renderAccount({
    account, plan, csrf, error = '', notice = '', activeSessions,
    ownDevices = [], ownClients = [], connectedDeviceIds = []
}) {
    const connected = new Set(connectedDeviceIds);
    const deviceItems = ownDevices.length ? ownDevices.map((d) => `<li>
      <div class="top"><strong>${esc(d.name || d.id)}</strong><span class="pill ${connected.has(d.id) ? 'ok' : ''}">${connected.has(d.id) ? 'çevrimiçi' : 'çevrimdışı'}</span></div>
      <div class="meta">${esc(d.id)} · son görülme ${esc(when(d.lastSeenAt))}</div>
      <form method="post" action="/devices/release" class="row">${csrfField(csrf)}<input type="hidden" name="deviceId" value="${esc(d.id)}"><button type="submit" class="danger">Bağı Kopar</button></form>
    </li>`).join('') : '<li class="empty">Bu yönetici hesabına bağlı cihaz yok.</li>';

    return layout({
        title: 'Yönetici Hesabı · MCP Bridge',
        nav: nav('account', account.email),
        body: `
  <div class="page-head"><div><p class="eyebrow">Güvenlik ve Profil</p><h1>Yönetici Hesabı</h1><p class="sub">Panel parolanızı, oturumlarınızı ve operatör cihazlarınızı yönetin.</p></div><span class="pill">yönetici</span></div>
  ${banner('err', error)}
  ${banner('ok', notice)}

  <div class="grid two">
    <div class="card"><h2>Hesap Özeti</h2><dl class="definition"><dt>E-posta</dt><dd><code>${esc(account.email)}</code></dd><dt>Plan</dt><dd>${esc(plan.label)}</dd><dt>Açık panel oturumu</dt><dd>${esc(activeSessions)}</dd><dt>AI oturumu</dt><dd>${esc(ownClients.length)}</dd></dl></div>
    <div class="card"><h2>Plan Sınırları</h2><div class="grid two"><div class="stat"><div class="n">${esc(plan.maxDevices)}</div><div class="l">Cihaz</div></div><div class="stat"><div class="n">${esc(plan.commandsPerDay)}</div><div class="l">Günlük Komut</div></div></div><p class="sub">Denetim kayıtları ${esc(plan.auditRetentionDays)} gün saklanır.</p></div>
  </div>

  <div class="card"><h2>Parola Değiştir</h2>
    <form method="post" action="/account/password" class="row" style="flex-direction:column;align-items:stretch">
      ${csrfField(csrf)}
      <input type="password" name="current" placeholder="mevcut parola" autocomplete="current-password" required>
      <input type="password" name="next" placeholder="yeni parola" autocomplete="new-password" required>
      <div class="row"><button type="submit">Parolayı Değiştir</button></div>
    </form>
    <p class="sub">Parola değiştiğinde diğer tüm panel oturumları kapatılır. AI istemci anahtarları etkilenmez — onlar telefondan yönetilir.</p>
  </div>

  <div class="card"><h2>Operatör Cihazları</h2><p class="sub">Bu alan yalnızca yönetici hesabınızın cihazları içindir; kullanıcı cihazları burada açılmaz.</p><ul>${deviceItems}</ul>
    <form method="post" action="/devices/claim" class="row">${csrfField(csrf)}<input name="code" placeholder="telefondaki bağlama kodu" autocomplete="off" maxlength="16" required><button type="submit">Cihazı Bağla</button></form>
  </div>

  <div class="card danger-zone"><h2>Oturumlar</h2>
    <form method="post" action="/account/sessions/revoke" class="row">
      ${csrfField(csrf)}
      <button type="submit" class="danger">Diğer Tüm Oturumları Kapat</button>
    </form>
  </div>

  <div class="card"><h2>Çıkış</h2>
    <form method="post" action="/auth/logout" class="row">
      ${csrfField(csrf)}
      <button type="submit" class="ghost">Güvenli Çıkış</button>
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
    renderOperatorOverview,
    renderUsers,
    renderUserDetail,
    renderQuickLinks,
    renderAudit,
    renderAccount,
    renderMessage
};
