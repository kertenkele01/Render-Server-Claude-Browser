'use strict';

/**
 * The relay operator's global catalogue of recommended starting points.
 *
 * These are content, not authority. A phone still checks the calling client's
 * navigate permission before it opens one, and the AI remains free to use any
 * other site. Stable ids matter because an agent opens a recommendation by id
 * so it never has to reconstruct (and accidentally strip) an affiliate URL.
 */
const DEFAULT_QUICK_LINK_CATEGORIES = [
    ['category-general', 'Genel', 0],
    ['category-news', 'Haberler', 10],
    ['category-sports', 'Spor', 20],
    ['category-tech', 'Teknoloji', 30],
    ['category-stay', 'Konaklama', 40],
    ['category-flight', 'Uçuş', 50],
    ['category-shop', 'Alışveriş', 60]
].map(([id, title, sortOrder]) => ({
    id, title, sortOrder, createdAt: 0, updatedAt: 0
}));

const CATEGORY_BY_TITLE = new Map(DEFAULT_QUICK_LINK_CATEGORIES.map((row) => [row.title, row]));

const DEFAULT_QUICK_LINKS = [
    ['general-google', 'Genel', 'Google', 'https://www.google.com', 'Genel web araması ve farklı kaynaklara ulaşmak için.', 10],
    ['general-wikipedia', 'Genel', 'Wikipedia', 'https://www.wikipedia.org', 'Konular hakkında hızlı genel bilgi ve kaynak özeti için.', 20],
    ['general-github', 'Genel', 'GitHub', 'https://github.com', 'Yazılım projeleri, kaynak kodları ve teknik belgeler için.', 30],
    ['general-youtube', 'Genel', 'YouTube', 'https://www.youtube.com', 'Video, eğitim, inceleme ve görsel anlatım aramak için.', 40],
    ['news-bbc-tr', 'Haberler', 'BBC Türkçe', 'https://www.bbc.com/turkce', 'Türkçe dünya haberleri ve açıklayıcı dosyalar için.', 10],
    ['news-ntv', 'Haberler', 'NTV', 'https://www.ntv.com.tr', 'Türkiye gündemi ve güncel haber başlıkları için.', 20],
    ['news-reuters', 'Haberler', 'Reuters', 'https://www.reuters.com', 'Uluslararası son dakika, ekonomi ve şirket haberleri için.', 30],
    ['news-aa', 'Haberler', 'AA', 'https://www.aa.com.tr', 'Türkiye ve bölge odaklı güncel haber akışı için.', 40],
    ['sports-sporx', 'Spor', 'Sporx', 'https://www.sporx.com', 'Türkiye odaklı spor haberleri ve maç gündemi için.', 10],
    ['sports-espn', 'Spor', 'ESPN', 'https://www.espn.com', 'Uluslararası spor haberleri, skorlar ve istatistikler için.', 20],
    ['sports-uefa', 'Spor', 'UEFA', 'https://www.uefa.com', 'Avrupa futbol turnuvaları ve resmi maç bilgileri için.', 30],
    ['sports-nba', 'Spor', 'NBA', 'https://www.nba.com', 'NBA maçları, takımlar, oyuncular ve istatistikler için.', 40],
    ['tech-verge', 'Teknoloji', 'The Verge', 'https://www.theverge.com', 'Tüketici teknolojileri, ürünler ve teknoloji gündemi için.', 10],
    ['tech-ars', 'Teknoloji', 'Ars Technica', 'https://arstechnica.com', 'Derinlemesine teknoloji, bilim ve güvenlik içerikleri için.', 20],
    ['tech-webrazzi', 'Teknoloji', 'Webrazzi', 'https://webrazzi.com', 'Türkiye teknoloji, girişim ve dijital iş dünyası için.', 30],
    ['tech-hn', 'Teknoloji', 'Hacker News', 'https://news.ycombinator.com', 'Yazılım ve girişim topluluğundaki güncel bağlantılar için.', 40],
    ['stay-booking', 'Konaklama', 'Booking', 'https://www.booking.com', 'Otel ve konaklama seçeneklerini arayıp karşılaştırmak için.', 10],
    ['stay-airbnb', 'Konaklama', 'Airbnb', 'https://www.airbnb.com', 'Ev, daire ve kısa süreli konaklama seçenekleri için.', 20],
    ['stay-trivago', 'Konaklama', 'Trivago', 'https://www.trivago.com', 'Farklı sağlayıcılardaki otel fiyatlarını karşılaştırmak için.', 30],
    ['stay-hotels', 'Konaklama', 'Hotels', 'https://www.hotels.com', 'Otel arama, fiyat ve müsaitlik incelemesi için.', 40],
    ['flight-google', 'Uçuş', 'Google Flights', 'https://www.google.com/travel/flights', 'Tarih ve rota bazında uçuş fiyatlarını hızlı karşılaştırmak için.', 10],
    ['flight-skyscanner', 'Uçuş', 'Skyscanner', 'https://www.skyscanner.com', 'Havayolları ve acenteler arasında uçuş karşılaştırmak için.', 20],
    ['flight-kayak', 'Uçuş', 'Kayak', 'https://www.kayak.com', 'Uçuş seçeneklerini, tarihleri ve fiyatları karşılaştırmak için.', 30],
    ['flight-thy', 'Uçuş', 'THY', 'https://www.turkishairlines.com', 'Türk Hava Yolları uçuşlarını doğrudan aramak ve incelemek için.', 40],
    ['shop-trendyol', 'Alışveriş', 'Trendyol', 'https://www.trendyol.com', 'Türkiye’de ürün arama, fiyat ve kullanıcı yorumu incelemek için.', 10],
    ['shop-hepsiburada', 'Alışveriş', 'Hepsiburada', 'https://www.hepsiburada.com', 'Ürün seçenekleri, satıcılar ve fiyatları karşılaştırmak için.', 20],
    ['shop-amazon-tr', 'Alışveriş', 'Amazon', 'https://www.amazon.com.tr', 'Amazon Türkiye ürünleri, fiyatları ve yorumları için.', 30],
    ['shop-n11', 'Alışveriş', 'n11', 'https://www.n11.com', 'Türkiye’de farklı mağazalardaki ürünleri karşılaştırmak için.', 40]
].map(([id, category, name, url, description, sortOrder]) => ({
    id, category, name, url, sortOrder,
    categoryId: CATEGORY_BY_TITLE.get(category).id,
    categoryOrder: CATEGORY_BY_TITLE.get(category).sortOrder,
    description,
    active: true,
    openCount: 0,
    lastOpenedAt: null,
    createdAt: 0,
    updatedAt: 0
}));

const RECOMMENDATION_NOTE =
    'Bu siteler hizmet yönetimi tarafından AI tarayıcı görevleri için seçilmiş ' +
    'önerilen başlangıç noktalarıdır. Daha az sayfa okuma ve etkileşimle daha hızlı ' +
    'sonuç vermeleri ve daha düşük token tüketmeleri hedeflenmiştir. Göreve uygunsa ' +
    'kullanmanız önerilir; bunlarla sınırlı değilsiniz. Birini seçerseniz adresi yeniden ' +
    "yazmak veya aramak yerine 'browser_open_shortcut' ile shortcutId kaydını açın.";

function sortQuickLinks(rows) {
    return [...rows].sort((a, b) =>
        Number(a.categoryOrder || 0) - Number(b.categoryOrder || 0) ||
        String(a.category || '').localeCompare(String(b.category || ''), 'tr') ||
        Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'tr')
    );
}

function cataloguePayload(rows, revision) {
    const active = sortQuickLinks(rows.filter((row) => row.active !== false));
    const categories = [];
    const byCategory = new Map();
    active.forEach((row) => {
        let category = byCategory.get(row.category);
        if (!category) {
            category = { title: row.category, sites: [] };
            byCategory.set(row.category, category);
            categories.push(category);
        }
        category.sites.push({
            shortcutId: row.id,
            name: row.name,
            url: row.url,
            description: row.description || ''
        });
    });
    return { revision: Number(revision || 0), note: RECOMMENDATION_NOTE, categories };
}

module.exports = {
    DEFAULT_QUICK_LINK_CATEGORIES,
    DEFAULT_QUICK_LINKS,
    RECOMMENDATION_NOTE,
    sortQuickLinks,
    cataloguePayload
};
