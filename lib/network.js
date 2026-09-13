'use strict';

/** A configured external HTTPS origin avoids trusting public Host headers. */
function publicOrigin() {
    const raw = (process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').trim();
    if (!raw) return '';
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('PUBLIC_ORIGIN is invalid'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('PUBLIC_ORIGIN must be a clean HTTPS origin');
    }
    return url.origin;
}

module.exports = { publicOrigin };
