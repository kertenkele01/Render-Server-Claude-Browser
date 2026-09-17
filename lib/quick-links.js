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
    ['category-general', 'General', 0],
    ['category-news', 'News', 10],
    ['category-sports', 'Sports', 20],
    ['category-tech', 'Technology', 30],
    ['category-stay', 'Accommodation', 40],
    ['category-flight', 'Flights', 50],
    ['category-shop', 'Shopping', 60]
].map(([id, title, sortOrder]) => ({
    id, title, sortOrder, createdAt: 0, updatedAt: 0
}));

const CATEGORY_BY_TITLE = new Map(DEFAULT_QUICK_LINK_CATEGORIES.map((row) => [row.title, row]));

const DEFAULT_QUICK_LINKS = [
    ['general-google', 'General', 'Google', 'https://www.google.com', 'General web search and discovery across sources.', 10],
    ['general-wikipedia', 'General', 'Wikipedia', 'https://www.wikipedia.org', 'Quick topic overviews and source discovery.', 20],
    ['general-github', 'General', 'GitHub', 'https://github.com', 'Software projects, source code, and technical documentation.', 30],
    ['general-youtube', 'General', 'YouTube', 'https://www.youtube.com', 'Videos, tutorials, reviews, and visual explanations.', 40],
    ['news-bbc-tr', 'News', 'BBC Türkçe', 'https://www.bbc.com/turkce', 'Turkish-language world news and explainers.', 10],
    ['news-ntv', 'News', 'NTV', 'https://www.ntv.com.tr', 'Current Turkish news and headlines.', 20],
    ['news-reuters', 'News', 'Reuters', 'https://www.reuters.com', 'International breaking, business, and company news.', 30],
    ['news-aa', 'News', 'AA', 'https://www.aa.com.tr', 'Current news focused on Türkiye and the region.', 40],
    ['sports-sporx', 'Sports', 'Sporx', 'https://www.sporx.com', 'Türkiye-focused sports and match news.', 10],
    ['sports-espn', 'Sports', 'ESPN', 'https://www.espn.com', 'International sports news, scores, and statistics.', 20],
    ['sports-uefa', 'Sports', 'UEFA', 'https://www.uefa.com', 'Official European football tournament and match information.', 30],
    ['sports-nba', 'Sports', 'NBA', 'https://www.nba.com', 'NBA games, teams, players, and statistics.', 40],
    ['tech-verge', 'Technology', 'The Verge', 'https://www.theverge.com', 'Consumer technology, products, and industry news.', 10],
    ['tech-ars', 'Technology', 'Ars Technica', 'https://arstechnica.com', 'In-depth technology, science, and security coverage.', 20],
    ['tech-webrazzi', 'Technology', 'Webrazzi', 'https://webrazzi.com', 'Technology, startups, and digital business in Türkiye.', 30],
    ['tech-hn', 'Technology', 'Hacker News', 'https://news.ycombinator.com', 'Current software and startup community links.', 40],
    ['stay-booking', 'Accommodation', 'Booking', 'https://www.booking.com', 'Search and compare hotel and accommodation options.', 10],
    ['stay-airbnb', 'Accommodation', 'Airbnb', 'https://www.airbnb.com', 'Homes, apartments, and short-term stays.', 20],
    ['stay-trivago', 'Accommodation', 'Trivago', 'https://www.trivago.com', 'Compare hotel prices across providers.', 30],
    ['stay-hotels', 'Accommodation', 'Hotels', 'https://www.hotels.com', 'Hotel search, prices, and availability.', 40],
    ['flight-google', 'Flights', 'Google Flights', 'https://www.google.com/travel/flights', 'Quick date- and route-based flight comparison.', 10],
    ['flight-skyscanner', 'Flights', 'Skyscanner', 'https://www.skyscanner.com', 'Compare flights across airlines and agencies.', 20],
    ['flight-kayak', 'Flights', 'Kayak', 'https://www.kayak.com', 'Compare flight options, dates, and prices.', 30],
    ['flight-thy', 'Flights', 'THY', 'https://www.turkishairlines.com', 'Search Turkish Airlines flights directly.', 40],
    ['shop-trendyol', 'Shopping', 'Trendyol', 'https://www.trendyol.com', 'Search products, prices, and customer reviews in Türkiye.', 10],
    ['shop-hepsiburada', 'Shopping', 'Hepsiburada', 'https://www.hepsiburada.com', 'Compare product options, sellers, and prices.', 20],
    ['shop-amazon-tr', 'Shopping', 'Amazon', 'https://www.amazon.com.tr', 'Amazon Türkiye products, prices, and reviews.', 30],
    ['shop-n11', 'Shopping', 'n11', 'https://www.n11.com', 'Compare products from different stores in Türkiye.', 40]
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
    'These are optional operator-curated starting points for AI browser tasks. ' +
    'A relevant shortcut can reduce page reads, interactions, and token use. ' +
    'You may use any other site. If you choose one, call browser_open_shortcut ' +
    'with its shortcutId instead of rewriting or searching for its URL.';

const DEFAULT_LINK_BY_ID = new Map(DEFAULT_QUICK_LINKS.map((row) => [row.id, row]));
const DEFAULT_CATEGORY_BY_ID = new Map(DEFAULT_QUICK_LINK_CATEGORIES.map((row) => [row.id, row]));
const LEGACY_CATEGORY_TITLES = new Set([
    'Genel', 'Haberler', 'Spor', 'Teknoloji', 'Konaklama', 'Uçuş', 'Alışveriş'
]);
const TURKISH_SYSTEM_TEXT = /[çğıöşüÇĞİÖŞÜ]/;

/**
 * Preserve operator edits while translating rows seeded by older releases.
 * The catalogue revision belongs to operator content, so a code-only wording
 * update must also work when the existing database is not reseeded.
 */
function aiFacingQuickLink(row) {
    const builtIn = DEFAULT_LINK_BY_ID.get(row.id);
    const builtInCategory = DEFAULT_CATEGORY_BY_ID.get(row.categoryId);
    const category = builtInCategory && LEGACY_CATEGORY_TITLES.has(String(row.category || ''))
        ? builtInCategory.title
        : row.category;
    const currentDescription = String(row.description || '').trim();
    const description = builtIn && (!currentDescription || TURKISH_SYSTEM_TEXT.test(currentDescription))
        ? builtIn.description
        : currentDescription;
    return { ...row, category, description };
}

function sortQuickLinks(rows) {
    return [...rows].sort((a, b) =>
        Number(a.categoryOrder || 0) - Number(b.categoryOrder || 0) ||
        String(a.category || '').localeCompare(String(b.category || ''), 'tr') ||
        Number(a.sortOrder || 0) - Number(b.sortOrder || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'tr')
    );
}

function cataloguePayload(rows, revision) {
    const active = sortQuickLinks(rows.filter((row) => row.active !== false).map(aiFacingQuickLink));
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
