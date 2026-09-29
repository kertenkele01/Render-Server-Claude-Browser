'use strict';

// Native forms/details keep the operator console usable with scripting disabled.
function renderQuickLinksBody({ catalogue, categories, csrf, report, filters = {}, error = '', notice = '' },
    { esc, when, csrfField, quickLinkSiteFields, banner }) {
    const number = (value) => Number(value || 0).toLocaleString('tr-TR');
    const range = report.range;
    const selected = (value, actual) => value === actual ? ' selected' : '';
    const query = String(filters.q || '').slice(0, 100).trim();
    const categoryId = categories.some((row) => row.id === filters.category) ? filters.category : '';
    const state = ['active', 'hidden'].includes(filters.state) ? filters.state : '';
    const sort = ['opens', 'total', 'name'].includes(filters.sort) ? filters.sort : 'order';
    const url = (changes = {}, anchor = '') => {
        const params = new URLSearchParams({ period: range.period, group: range.group });
        if (range.period === 'custom') { params.set('from', range.fromDate); params.set('to', range.toDate); }
        for (const [key, value] of Object.entries({ q: query, category: categoryId, state, sort, ...changes })) {
            if (value) params.set(key, value);
        }
        return esc('/admin/quick-links?' + params.toString() + anchor);
    };
    const stats = (stat) => `<div class="ql-mini-stats">
        <span><small>Bugün</small><strong>${esc(number(stat.today))}</strong></span>
        <span><small>Bu ay</small><strong>${esc(number(stat.month))}</strong></span>
        <span><small>Seçilen dönem</small><strong>${esc(number(stat.period))}</strong></span>
        <span><small>Toplam</small><strong>${esc(number(stat.total))}</strong></span></div>`;
    const siteCategory = new Map(categories.map((row) => [row.id, row]));
    const visible = catalogue.links.filter((link) => {
        const searchText = `${link.name} ${siteCategory.get(link.categoryId)?.title || ''} ${link.description} ${host(link.url)}`;
        return (!query || searchText.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr'))) &&
            (!categoryId || link.categoryId === categoryId) &&
            (!state || (state === 'active' ? link.active !== false : link.active === false));
    });
    if (sort !== 'order') visible.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'tr') :
        report.bySite.get(b.id)[sort === 'total' ? 'total' : 'period'] -
        report.bySite.get(a.id)[sort === 'total' ? 'total' : 'period'] || a.name.localeCompare(b.name, 'tr'));
    const editing = catalogue.links.find((row) => row.id === filters.edit);
    const max = Math.max(1, ...report.buckets.map((row) => row.count));
    const trends = report.buckets.map((row) => `<div class="ql-chart-column" title="${esc(row.date)}: ${esc(number(row.count))} açılış">
        <span>${esc(number(row.count))}</span><i style="height:${row.count ? Math.max(3, row.count / max * 100) : 0}px"></i>
        <small>${esc(row.date.slice(range.group === 'month' ? 5 : 8))}</small></div>`).join('');
    const categoryCards = categories.map((category) => {
        const links = catalogue.links.filter((row) => row.categoryId === category.id);
        const stat = report.byCategory.get(category.id);
        return `<article class="ql-category">
          <div class="card-head"><div><h3>${esc(category.title)}</h3><p class="meta">${esc(links.length)} site · sıra ${esc(category.sortOrder)}</p></div>
          <a class="button ghost" href="${url({ category: category.id, edit: '' }, '#sites')}">Siteleri gör →</a></div>
          ${stats(stat)}
          <details><summary>Kategoriyi düzenle</summary><form method="post" action="/admin/quick-links/categories/save" class="row ql-edit-form">
            ${csrfField(csrf)}<input type="hidden" name="id" value="${esc(category.id)}">
            <div class="field"><label for="title-${esc(category.id)}">Kategori adı</label><input id="title-${esc(category.id)}" name="title" maxlength="60" required value="${esc(category.title)}"></div>
            <div class="field"><label for="order-${esc(category.id)}">Gösterim sırası</label><input id="order-${esc(category.id)}" name="sortOrder" type="number" min="0" max="9999" required value="${esc(category.sortOrder)}"></div>
            <button type="submit">Kategoriyi kaydet</button></form>
            ${links.length ? '<p class="meta">Kategoriyi silmek için önce içindeki siteleri taşıyın veya kaldırın.</p>' :
                `<details class="ql-delete"><summary>Kategoriyi sil</summary><form method="post" action="/admin/quick-links/categories/delete" class="stack">
                ${csrfField(csrf)}<input type="hidden" name="id" value="${esc(category.id)}">
                <label class="row"><input type="checkbox" required> Bu boş kategoriyi kalıcı olarak kaldır.</label>
                <button class="danger" type="submit">Kategoriyi sil</button></form></details>`}</details>
        </article>`;
    }).join('');
    const rows = visible.map((link) => {
        const stat = report.bySite.get(link.id);
        return `<tr><td><strong>${esc(link.name)}</strong><span class="ql-host">${esc(host(link.url))}</span></td>
          <td>${esc(siteCategory.get(link.categoryId)?.title || link.category)}</td>
          <td><span class="pill ${link.active !== false ? 'ok' : ''}">${link.active !== false ? 'Yayında' : 'Gizli'}</span></td>
          <td class="ql-count">${esc(number(stat.today))}</td><td class="ql-count">${esc(number(stat.month))}</td>
          <td class="ql-count ql-emphasis">${esc(number(stat.period))}</td><td class="ql-count">${esc(number(stat.total))}</td>
          <td class="meta">${esc(when(link.lastOpenedAt))}</td><td><a class="button ghost" href="${url({ edit: link.id }, '#edit-site')}">Düzenle</a></td></tr>`;
    }).join('');
    const editor = editing ? `<section class="card ql-editor" id="edit-site">
      <div class="card-head"><div><p class="eyebrow">Site düzenleme</p><h3>${esc(editing.name)}</h3></div><a class="button ghost" href="${url({ edit: '' }, '#sites')}">Düzenlemeyi kapat</a></div>
      ${stats(report.bySite.get(editing.id))}
      <form method="post" action="/admin/quick-links/save" class="row">${csrfField(csrf)}
      <input type="hidden" name="id" value="${esc(editing.id)}">${quickLinkSiteFields(editing, categories)}<button type="submit">Siteyi kaydet</button></form>
      <details class="ql-delete"><summary>Siteyi kalıcı olarak sil</summary><p class="sub">Site katalogdan ve açılış raporlarından kaldırılır. Geçici kaldırmak için durumunu “Gizli” yapın.</p>
      <form method="post" action="/admin/quick-links/delete" class="row">${csrfField(csrf)}<input type="hidden" name="id" value="${esc(editing.id)}">
      <label class="row"><input type="checkbox" required> Bu siteyi ve açılış sayaçlarını kalıcı olarak kaldır.</label><button class="danger" type="submit">Kalıcı olarak sil</button></form></details>
    </section>` : '';
    return `<div class="page-head"><div><p class="eyebrow">Katalog &amp; açılış analitiği</p><h1>Hazır Siteler</h1>
      <p class="sub">${esc(categories.length)} kategori · ${esc(catalogue.links.length)} site · katalog sürümü ${esc(catalogue.revision)}</p></div>
      <div class="actions"><a class="button ghost" href="#new-category">+ Kategori ekle</a><a class="button" href="#new-site">+ Site ekle</a></div></div>
      ${banner('err', error)}${banner('ok', notice)}
      <div class="grid ql-overview">${[['today', 'Bugün'], ['week', 'Son 7 gün'], ['month', 'Bu ay'], ['total', 'Tüm zamanlar']].map(([key, label]) =>
        `<div class="stat"><div class="l">${label}</div><div class="n">${esc(number(report.totals[key]))}</div><div class="hint">Katalog toplamı · açılış</div></div>`).join('')}</div>
      <section class="card" id="report"><div class="card-head"><div><h2>Açılış raporu</h2><p class="sub">${esc(range.label)} · ${esc(range.fromDate)} — ${esc(range.toDate)} · UTC</p></div>
      <span class="pill pro">${esc(number(report.totals.period))} açılış</span></div>
      <form method="get" action="/admin/quick-links#report" class="row ql-report-filter">
      ${Object.entries({ q: query, category: categoryId, state, sort }).map(([key, value]) => `<input type="hidden" name="${key}" value="${esc(value)}">`).join('')}
      <div class="field"><label for="ql-period">Dönem</label><select id="ql-period" name="period">${[['today', 'Bugün'], ['week', 'Son 7 gün'], ['month', 'Bu ay'], ['days30', 'Son 30 gün'], ['year', 'Bu yıl'], ['custom', 'Özel tarih aralığı']].map(([value, label]) => `<option value="${value}"${selected(value, range.period)}>${label}</option>`).join('')}</select></div>
      <div class="field"><label for="ql-from">Başlangıç</label><input id="ql-from" type="date" name="from" value="${esc(range.fromDate)}" max="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label for="ql-to">Bitiş</label><input id="ql-to" type="date" name="to" value="${esc(range.toDate)}" max="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label for="ql-group">Grafik görünümü</label><select id="ql-group" name="group"><option value="day"${selected('day', range.group)}>Günlük</option><option value="month"${selected('month', range.group)}>Aylık</option></select></div>
      <button type="submit">Raporu göster</button></form>
      <p class="meta">Tarih alanlarını kullanmak için “Özel tarih aralığı” seçin. 62 günden uzun grafikler aylık gösterilir.</p>
      <div class="ql-chart" role="img" aria-label="${esc(range.label)}: ${esc(number(report.totals.period))} açılış; aşağıda tablo olarak da gösterilir">${trends}</div>
      <details><summary>Dönem dökümünü tablo olarak gör</summary><div class="table-wrap"><table class="ql-breakdown"><thead><tr><th>Tarih (UTC)</th><th>Açılış</th></tr></thead><tbody>${report.buckets.map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(number(row.count))}</td></tr>`).join('')}</tbody></table></div></details>
      <p class="meta">Dönemli sayaçlar ${esc(when(report.startedAt))} itibarıyla tutulur. Önceki açılışlar yalnızca tüm zamanlar toplamına dahildir; ilk gün kısmi olabilir. Kategori raporları sitelerin mevcut kategorilerine göre hesaplanır.</p></section>
      <section class="card" id="categories"><div class="card-head"><div><h2>Kategori yönetimi</h2><p class="sub">Kategori bazında bugünkü, aylık, seçilen dönem ve toplam açılışlar.</p></div><a href="#new-category">Yeni kategori +</a></div>
      <div class="ql-category-grid">${categoryCards || '<p class="empty">Henüz kategori yok. Aşağıdan ilk kategoriyi ekleyin.</p>'}</div></section>
      <section class="card" id="sites"><div class="card-head"><div><h2>Site yönetimi</h2><p class="sub">${esc(visible.length)} / ${esc(catalogue.links.length)} site gösteriliyor · seçilen dönem: ${esc(range.label)}</p></div><a href="#new-site">Yeni site +</a></div>
      <form method="get" action="/admin/quick-links#sites" class="row">${['period', 'group'].map((key) => `<input type="hidden" name="${key}" value="${esc(range[key])}">`).join('')}
      ${range.period === 'custom' ? `<input type="hidden" name="from" value="${esc(range.fromDate)}"><input type="hidden" name="to" value="${esc(range.toDate)}">` : ''}
      <div class="field"><label for="ql-search">Site ara</label><input id="ql-search" name="q" type="search" maxlength="100" value="${esc(query)}" placeholder="Site adı, kategori veya alan adı"></div>
      <div class="field"><label for="ql-category">Kategori</label><select id="ql-category" name="category"><option value="">Tüm kategoriler</option>${categories.map((row) => `<option value="${esc(row.id)}"${selected(row.id, categoryId)}>${esc(row.title)}</option>`).join('')}</select></div>
      <div class="field"><label for="ql-state">Durum</label><select id="ql-state" name="state"><option value="">Tüm durumlar</option><option value="active"${selected('active', state)}>Yayında</option><option value="hidden"${selected('hidden', state)}>Gizli</option></select></div>
      <div class="field"><label for="ql-sort">Sıralama</label><select id="ql-sort" name="sort">${[['order', 'Katalog sırası'], ['opens', 'Dönem açılışı ↓'], ['total', 'Toplam açılış ↓'], ['name', 'Site adı A–Z']].map(([value, label]) => `<option value="${value}"${selected(value, sort)}>${label}</option>`).join('')}</select></div><button type="submit" class="ghost">Filtrele</button><a href="${url({ q: '', category: '', state: '', sort: 'order', edit: '' }, '#sites')}">Temizle</a></form>
      ${rows ? `<div class="table-wrap"><table class="ql-site-table"><thead><tr><th>Site</th><th>Kategori</th><th>Durum</th><th>Bugün</th><th>Bu ay</th><th>Seçilen dönem</th><th>Toplam</th><th>Son açılış</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Bu filtrelerle eşleşen site yok.</p>'}
      <p class="meta">Açılışlar, bağlı uygulamanın kullanıcı veya AI tarafından gerçekten açıldığını bildirdiği hızlı linkleri sayar. Benzersiz kullanıcı veya sayfa görüntüleme sayısı değildir.</p></section>
      ${editor}
      <div class="ql-create-grid"><section class="card" id="new-category"><h2>Yeni kategori ekle</h2><form method="post" action="/admin/quick-links/categories/save" class="stack">${csrfField(csrf)}
      <div class="field"><label for="new-category-title">Kategori adı</label><input id="new-category-title" name="title" maxlength="60" required placeholder="Örn. Seyahat"></div>
      <div class="field"><label for="new-category-order">Gösterim sırası</label><input id="new-category-order" name="sortOrder" type="number" min="0" max="9999" required value="0"></div>
      <p class="meta">Küçük sıra numaraları önce gösterilir. Site eklemeden de kategori oluşturabilirsiniz.</p><button type="submit">Kategori ekle</button></form></section>
      <section class="card" id="new-site"><h2>Yeni site ekle</h2>${categories.length ? `<form method="post" action="/admin/quick-links/save" class="row">${csrfField(csrf)}${quickLinkSiteFields({ active: true, categoryId: categoryId || categories[0].id }, categories)}<button type="submit">Siteyi ekle</button></form>` : '<p class="empty">Site eklemeden önce bir kategori oluşturun.</p>'}</section></div>
      <p class="sub">Yönetim tarafından seçilen isteğe bağlı öneriler; daha az sayfa okuma, etkileşim ve token tüketimi hedeflenir. AI istediği başka bir siteyi kullanabilir. Kayıtlı HTTPS adresleri ve affiliate parametreleri korunur; analitik yalnızca site kimliği, gün ve sayaç tutar.</p>`;
}

function host(url) { try { return new URL(url).hostname; } catch { return ''; } }

module.exports = { renderQuickLinksBody };
