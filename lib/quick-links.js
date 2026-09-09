'use strict';

/**
 * The relay operator's global catalogue of recommended starting points.
 *
 * These are content, not authority. A phone still checks the calling client's
 * navigate permission before it opens one, and the AI remains free to use any
 * other site. Stable ids matter because an agent opens a recommendation by id
 * so it never has to reconstruct (and accidentally strip) an affiliate URL.
 */
const DEFAULT_QUICK_LINKS = [
    ['general-google', 'Genel', 'Google', 'https://www.google.com', 10],
    ['general-wikipedia', 'Genel', 'Wikipedia', 'https://www.wikipedia.org', 20],
    ['general-github', 'Genel', 'GitHub', 'https://github.com', 30],
    ['general-youtube', 'Genel', 'YouTube', 'https://www.youtube.com', 40],
    ['news-bbc-tr', 'Haberler', 'BBC Türkçe', 'https://www.bbc.com/turkce', 10],
    ['news-ntv', 'Haberler', 'NTV', 'https://www.ntv.com.tr', 20],
    ['news-reuters', 'Haberler', 'Reuters', 'https://www.reuters.com', 30],
    ['news-aa', 'Haberler', 'AA', 'https://www.aa.com.tr', 40],
    ['sports-sporx', 'Spor', 'Sporx', 'https://www.sporx.com', 10],
    ['sports-espn', 'Spor', 'ESPN', 'https://www.espn.com', 20],
    ['sports-uefa', 'Spor', 'UEFA', 'https://www.uefa.com', 30],
    ['sports-nba', 'Spor', 'NBA', 'https://www.nba.com', 40],
    ['tech-verge', 'Teknoloji', 'The Verge', 'https://www.theverge.com', 10],
    ['tech-ars', 'Teknoloji', 'Ars Technica', 'https://arstechnica.com', 20],
    ['tech-webrazzi', 'Teknoloji', 'Webrazzi', 'https://webrazzi.com', 30],
    ['tech-hn', 'Teknoloji', 'Hacker News', 'https://news.ycombinator.com', 40],
    ['stay-booking', 'Konaklama', 'Booking', 'https://www.booking.com', 10],
    ['stay-airbnb', 'Konaklama', 'Airbnb', 'https://www.airbnb.com', 20],
    ['stay-trivago', 'Konaklama', 'Trivago', 'https://www.trivago.com', 30],
    ['stay-hotels', 'Konaklama', 'Hotels', 'https://www.hotels.com', 40],
    ['flight-google', 'Uçuş', 'Google Flights', 'https://www.google.com/travel/flights', 10],
    ['flight-skyscanner', 'Uçuş', 'Skyscanner', 'https://www.skyscanner.com', 20],
    ['flight-kayak', 'Uçuş', 'Kayak', 'https://www.kayak.com', 30],
    ['flight-thy', 'Uçuş', 'THY', 'https://www.turkishairlines.com', 40],
    ['shop-trendyol', 'Alışveriş', 'Trendyol', 'https://www.trendyol.com', 10],
    ['shop-hepsiburada', 'Alışveriş', 'Hepsiburada', 'https://www.hepsiburada.com', 20],
    ['shop-amazon-tr', 'Alışveriş', 'Amazon', 'https://www.amazon.com.tr', 30],
    ['shop-n11', 'Alışveriş', 'n11', 'https://www.n11.com', 40]
].map(([id, category, name, url, sortOrder], index) => ({
    id, category, name, url, sortOrder,
    categoryOrder: Math.floor(index / 4) * 10,
    description: '',
    active: true,
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

module.exports = { DEFAULT_QUICK_LINKS, RECOMMENDATION_NOTE, sortQuickLinks, cataloguePayload };
