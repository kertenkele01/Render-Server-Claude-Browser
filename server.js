const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID, createHash, timingSafeEqual, randomInt, randomBytes } = require('crypto');

const fs = require('fs');
const path = require('path');

const { openStore } = require('./lib/store');
const accounts = require('./lib/auth');
const limits = require('./lib/limits');
const panel = require('./lib/panel');
const oauth = require('./lib/oauth');
const { cataloguePayload } = require('./lib/quick-links');

const app = express();
app.disable('x-powered-by');
// Tool-call payloads are small; the device streams large results back over the
// WebSocket, never through this body parser.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// ----------------------------------------------------
// CONFIG
// ----------------------------------------------------
// Load a local .env when present. Hosted environments (Render) inject real
// environment variables and have no .env file, so this is a no-op there.
// process.loadEnvFile is built into Node 20.12+; older runtimes just skip it.
try {
    if (typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(__dirname, '.env'))) {
        process.loadEnvFile(path.join(__dirname, '.env'));
        console.log('[Config] Loaded .env');
    }
} catch (e) {
    console.warn('[Config] Could not read .env:', e.message);
}

// ADMIN_TOKEN and ADMIN_PUBLIC are gone. They were a stand-in for "there is
// one operator and it is me": a single shared token that unlocked a console
// listing every device on the relay and the hosts each one was visiting. With
// accounts, that is no longer a convenience, it is a way to hand one tenant
// everybody else's browsing. The panel is behind a real session now.
//
// ALLOW_REGISTRATION closes signups on a private deployment. Open by default so
// a fresh install is usable; the first account is the operator's own.
const ALLOW_REGISTRATION = !/^(0|false|no|off)$/i.test((process.env.ALLOW_REGISTRATION || 'true').trim());

// Operator accounts, by email. Named in the environment rather than granted
// through a UI so that promoting yourself is not something a signup can do.
// Matching accounts get the console; everyone else is a normal user whose whole
// experience lives in the Android app.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
// MCP clients are not browsers, so no cross-origin access is required. Set
// ALLOWED_ORIGINS only if you deliberately front the bridge with a web app.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
        return res.sendStatus(origin && ALLOWED_ORIGINS.includes(origin) ? 200 : 403);
    }
    next();
});

const server = createServer(app);
function positiveEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
const MAX_WS_PAYLOAD_BYTES = positiveEnv('MAX_WS_PAYLOAD_BYTES', 1024 * 1024);
const MAX_UNAUTH_WS_GLOBAL = positiveEnv('MAX_UNAUTH_WS_GLOBAL', 64);
const MAX_UNAUTH_WS_PER_IP = positiveEnv('MAX_UNAUTH_WS_PER_IP', 8);
const MAX_SSE_CHANNELS_GLOBAL = positiveEnv('MAX_SSE_CHANNELS_GLOBAL', 500);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
let unauthenticatedWebSockets = 0;
const unauthenticatedWebSocketsByIp = new Map();

// Active connections
const browsers = new Map();        // deviceId -> live WebSocket
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }

// ----------------------------------------------------
// IDENTITY REGISTRY
//
// The device is the authority: it mints every clientId/clientSecret and tells
// us only the hash. We keep the hash so we can reject bad credentials early,
// and explicit clientId -> authorised-device bindings so a command can never
// be routed to somebody else's phone. The original phone remains the default;
// another phone may join only under the same account with the same hash.
//
// These two Maps are a *read cache* over `lib/store.js`, not the truth. Every
// MCP command calls `authenticate()`, and making that wait on a query would put
// a database round trip in front of every page read. Writes go to the store and
// refresh the cache; the cache is rebuilt at boot.
// ----------------------------------------------------
const devices = new Map(); // deviceId -> { id, accountId, secretHash, name, ... }
const clients = new Map(); // clientId -> { id, deviceId, deviceIds[], accountId, secretHash, name }

let store = null;

async function activeQuickLinkCatalogue() {
    const result = await store.listQuickLinks();
    return cataloguePayload(result.links, result.revision);
}

/** Content update only: phones still decide whether a navigation may run. */
async function broadcastQuickLinkCatalogue() {
    const catalog = await activeQuickLinkCatalogue();
    const frame = JSON.stringify({ type: 'quick_links_updated', catalog });
    browsers.forEach((ws) => {
        if (ws.readyState === 1) {
            try { ws.send(frame); } catch (e) {}
        }
    });
}

function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function safeEquals(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
}

// Accounts are read on the hot path only to check `status` and `plan`, both of
// which change rarely, so the same read-through treatment applies.
const accountCache = new Map(); // accountId -> account

/** Rebuilds the hot-path cache from the store. */
async function refreshRegistryCache() {
    const [deviceRows, clientRows] = await Promise.all([
        store.listAllDevices(),
        store.listAllClients()
    ]);
    devices.clear();
    clientRows.forEach((c) => clients.set(c.id, c));
    deviceRows.forEach((d) => devices.set(d.id, d));
    for (const id of [...clients.keys()]) {
        if (!clientRows.some((c) => c.id === id)) clients.delete(id);
    }
    const accountIds = new Set();
    deviceRows.forEach((d) => d.accountId && accountIds.add(d.accountId));
    accountCache.clear();
    for (const id of accountIds) {
        const account = await store.getAccountById(id);
        if (account) accountCache.set(id, account);
    }

    console.log(`[Registry] ${devices.size} cihaz, ${clients.size} istemci, ${accountCache.size} hesap önbelleğe alındı.`);
}

// ----------------------------------------------------
// CLAIM CODES
// How a phone gets attached to an account. The phone asks over its existing
// socket, shows the code, and the owner types it into the panel. Short-lived
// and single-use: it is a bearer token for "this device is mine", so it should
// be worth stealing for as little time as possible.
// ----------------------------------------------------
const CLAIM_CODE_TTL_MS = 10 * 60 * 1000;
// No 0/O/1/I/L: this is read off one screen and typed into another.
const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newClaimCode() {
    let out = '';
    for (let i = 0; i < 8; i++) out += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
    return out;
}

function normaliseClaimCode(value) {
    const cleaned = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return cleaned.length >= 6 && cleaned.length <= 16 ? cleaned : '';
}

async function issueClaimCode(deviceId) {
    const claim = {
        code: newClaimCode(),
        deviceId,
        createdAt: Date.now(),
        expiresAt: Date.now() + CLAIM_CODE_TTL_MS
    };
    await store.createClaimCode(claim);
    return claim;
}

// ----------------------------------------------------
// LOGGING — metadata only.
// Never record tokens, page content, or full URLs here: this bridge carries
// authenticated browsing sessions and the log is the easiest thing to leak.
// ----------------------------------------------------
/**
 * The audit trail.
 *
 * Same rule as before, and it has not softened: tool name, outcome, duration
 * and at most a **host**. Never a token, never page content, never a full URL.
 * What changed is where it goes — the in-memory ring was fine when there was
 * one operator reading it live, but an account expects to open the panel
 * tomorrow and still see what happened today.
 *
 * Writes are queued and flushed off the request path. An audit row is not worth
 * adding latency to a page read, and it is not worth failing a command over: if
 * the store is unhappy the event is dropped with a warning rather than
 * propagated to the caller.
 */
const auditQueue = [];
const AUDIT_QUEUE_MAX = 1000;
let auditFlushing = false;

function hostOf(url) {
    try { return new URL(String(url)).host; } catch (e) { return ''; }
}

/** Which account an event belongs to, resolved from the hot cache. */
function accountIdFor(clientId, deviceId) {
    if (clientId) {
        const c = clients.get(clientId);
        if (c && c.accountId) return c.accountId;
        if (c && c.deviceId) deviceId = deviceId || c.deviceId;
    }
    if (deviceId) {
        const d = devices.get(deviceId);
        if (d && d.accountId) return d.accountId;
    }
    return null;
}

function addLog(clientId, clientName, deviceId, action, status, detail, host = null) {
    const event = {
        accountId: accountIdFor(clientId, deviceId),
        deviceId: deviceId ? String(deviceId).substring(0, 64) : null,
        clientId: clientId ? String(clientId).substring(0, 64) : null,
        action: String(action || '').substring(0, 80),
        status: String(status || 'info').substring(0, 16),
        detail: detail ? String(detail).substring(0, 240) : null,
        host: host ? String(host).substring(0, 120) : null,
        createdAt: Date.now()
    };

    // An event with no account has nobody to show it to. It is still worth a
    // console line — this is how an unclaimed device announces itself.
    if (!event.accountId) {
        console.log(`[Audit] (sahipsiz) ${event.action} · ${event.status} · ${event.deviceId || '-'}`);
        return;
    }

    if (auditQueue.length >= AUDIT_QUEUE_MAX) {
        auditQueue.shift();
    }
    auditQueue.push(event);
    flushAudit();
}

async function flushAudit() {
    if (auditFlushing || !store || auditQueue.length === 0) return;
    auditFlushing = true;
    try {
        while (auditQueue.length) {
            const event = auditQueue.shift();
            try {
                await store.appendAudit(event);
            } catch (e) {
                console.warn('[Audit] Kayıt yazılamadı:', e.message);
            }
        }
    } finally {
        auditFlushing = false;
    }
}

// Standard MCP Tools schema
const TOOLS = [
    {
        name: "browser_get_tool_documentation",
        description: "Android Tarayıcı MCP Köprüsündeki tüm araçların (tools) detaylı kullanım kılavuzunu, parametrelerini, örnek çağrılarını ve en iyi ajansal iş akışlarını (Agent Best Practices / Playbooks) döner. Bir aracın nasıl çalıştığını öğrenmek veya karmaşık web otomasyon adımlarını planlamak için bu aracı çağırın.",
        inputSchema: {
            type: "object",
            properties: {
                tool_name: { 
                    type: "string", 
                    description: "Hakkında detaylı bilgi ve örnek iş akışı istenen aracın adı (örn. 'browser_get_markdown', 'browser_click', 'browser_type', 'browser_search', 'browser_navigate', 'all'). Boş bırakılırsa tüm araçların tam rehberini döner." 
                },
                category: { 
                    type: "string", 
                    enum: ["all", "navigation", "interaction", "content_extraction", "tabs_and_sessions", "meta"],
                    description: "Araç kategorisine göre filtreleme ('all', 'navigation', 'interaction', 'content_extraction', 'tabs_and_sessions', 'meta')" 
                }
            }
        }
    },
    {
        name: "browser_list_devices",
        description: "Bu AI bağlantısının kullanmasına izin verilmiş Android cihazlarını listeler. Her cihaz için cihaz kimliği, kullanıcıya görünen ad, çevrimiçi durum ve varsayılan hedef olup olmadığı döner. Birden fazla telefon varsa diğer browser_* araçlarında deviceId vermeden önce bunu çağırın. Bu araç yeni bir cihaza yetki vermez.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "browser_navigate",
        description: "Belirtilen adresi açar ve sayfa yerleştiğinde **ne bulduğunu** döner: yönlendirme sonrası gerçek adres, sayfa başlığı, başlık listesi ('headings'), link/form/giriş alanı sayıları ve sayfanın karakter uzunluğu. Bu özet, içeriği okumadan önce 'aradığım şey burada mı' sorusunu yanıtlamak içindir — gerekiyorsa 'browser_get_markdown' ile okuyun, ya da doğrudan tıklamaya/yazmaya geçin. İçeriği tek turda istiyorsanız 'read' parametresini true verin. Sayfa 6 saniyede yerleşmezse yanıt 'still_loading' durumuyla eldeki özeti döner; bu bir hata değildir.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Gidilecek tam adres (http veya https)" },
                read: { type: "boolean", description: "true verilirse sayfanın Markdown içeriği de aynı yanıtta döner. Varsayılan false: çoğu gezinme bir ara adımdır ve içeriği boşuna taşımak hem yavaş hem pahalıdır." },
                offset: { type: "integer", minimum: 0, description: "'read' true iken okunacak Markdown parçasının başlangıç karakteri." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_reload",
        description: "Aktif sekmedeki mevcut belgeyi tarayıcının gerçek yenileme işlemiyle yeniden yükler ve sayfa yerleştiğinde başlık, gerçek adres, başlık listesi ve öğe sayılarını döner. Aynı URL'ye browser_navigate çağırmaktan farklı olarak mevcut tarayıcı girişini yeniler. Bayat içerik veya geçici yükleme hatasında kullanın; CAPTCHA ya da işlem sonucunu değiştirmek için art arda yenilemeyin. İçeriği de aynı yanıtta almak için read=true verin.",
        inputSchema: {
            type: "object",
            properties: {
                read: { type: "boolean", description: "true verilirse yenilenen sayfanın Markdown içeriği de aynı yanıtta döner." },
                offset: { type: "integer", minimum: 0, description: "'read' true iken okunacak Markdown parçasının başlangıç karakteri." },
                tabId: { type: "string", description: "Yenilenecek sekmenin ID'si (opsiyonel, verilmezse aktif sekme)." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_search",
        description: "Google'da arama yapar ve sonuç sayfasının özetini döner: başlık, başlık listesi, link sayısı ve sayfa uzunluğu. Sonuçları okumak için 'browser_get_markdown' çağırın veya 'read' parametresini true verin.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Aranacak kelime veya cümle" },
                read: { type: "boolean", description: "true verilirse sonuç sayfasının Markdown içeriği de aynı yanıtta döner." },
                offset: { type: "integer", minimum: 0, description: "'read' true iken okunacak Markdown parçasının başlangıç karakteri." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["query"]
        }
    },
    {
        name: "browser_screenshot",
        description: "Sekmenin görüntüsünü JPEG olarak alır ve MCP görüntü bloğu olarak döner. grid=true verilirse görünen alan varsayılan olarak yaklaşık 48 px karelerden oluşan 15×24 yarı saydam hücreye ayrılır, A1..O24 etiketleri ve 30 saniyelik tek kullanımlık screenshot_id döner; grid_columns/grid_rows ile yoğunluk isteğe göre değiştirilebilir. Ardından browser_click_at ile hücreye veya kesin piksele fiziksel dokunabilirsiniz. Grid yalnızca görünür alan içindir ve fullPage'i geçersiz kılar. Android yalnızca ekranda olan bir WebView'ı çizdiği için arka plandaki sekme, uygulama ön plandaysa bir anlığına gösterilip geri alınır. Uygulama ön planda değilse blank_capture döner.",
        inputSchema: {
            type: "object",
            properties: {
                fullPage: { type: "boolean", description: "true ise yalnızca görünen alan yerine sayfanın tamamı yakalanır. Telefonda o an ekranda olan sekmede yok sayılır (yanıt 'full_page' alanında hangisinin alındığını bildirir)." },
                grid: { type: "boolean", description: "true ise görüntünün üzerine koordinat hücreleri çizer ve browser_click_at için screenshot_id üretir. Grid modunda fullPage yok sayılır." },
                grid_columns: { type: "integer", minimum: 4, maximum: 26, description: "Grid sütun sayısı. Varsayılan 15; sütunlar A-Z ile adlandırılır." },
                grid_rows: { type: "integer", minimum: 4, maximum: 40, description: "Grid satır sayısı. Varsayılan 24." },
                tabId: { type: "string", description: "Hedef sekme ID'si (opsiyonel, verilmezse oturumun aktif sekmesi)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_html",
        description: "Şu an açık olan sayfanın saf HTML kaynağını (`html`), sayfa URL'sini ve sayfa başlığını alır.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_markdown",
        description: "Şu an açık olan sayfanın Markdown içeriğini (`markdown`) alır. Dönüşüm cihazda yapılır: çıktı düz bir metin dökümü değil, tıklanabilir öğelerin numaralandırıldığı bir etkileşim haritasıdır — buradaki ID sayılarını doğrudan `browser_click` ve `browser_type` ile kullanabilirsiniz. Şifre, kart ve OTP alanlarının değerleri asla okunmaz. Telefonda token tasarrufu açıksa yanıt 80.000 karakterlik parçalara ayrılır; `has_more` true olduğunda `next_offset` değeriyle devam edin.",
        inputSchema: {
            type: "object",
            properties: {
                offset: { type: "integer", minimum: 0, description: "Token tasarrufu açıkken okunacak Markdown parçasının başlangıç karakteri. İlk çağrıda 0 veya boş bırakın; devam için önceki yanıttaki next_offset değerini verin." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_scroll",
        description: "Sayfayı yukarı veya aşağı kaydırır.",
        inputSchema: {
            type: "object",
            properties: {
                direction: { type: "string", enum: ["up", "down"], description: "Kaydırma yönü ('up' veya 'down', varsayılan 'down')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_click",
        description: "Bir öğeye tıklar. Tıklama gerçek bir işaretçi dizisi olarak gönderilir (pointerdown → mousedown → pointerup → mouseup → click), çünkü takvimler, açılır menüler ve yolcu seçiciler gibi özel bileşenler yalnızca 'click' olayını değil bu zinciri dinler. Yanıt, tıklamanın **etkisi olup olmadığını** söyler: 'page_changed', adres değiştiyse 'new_url', bir öneri listesi açıldıysa 'suggestions'. 'page_changed' false ise öğe bulunmuştur ama beklenen etkiyi yapmamıştır — aynı tıklamayı tekrarlamak yerine sayfayı yeniden okuyun. Element numaraları 'browser_get_markdown' geçişinde atanır; sayfa değiştiyse numaralar reddedilir ve yeniden okumanız istenir.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Markdown çıktısındaki element ID sayısı (ör. '12') veya bir CSS seçici. Sayı kullanmak daha güvenilirdir." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector"]
        }
    },
    {
        name: "browser_click_at",
        description: "browser_screenshot(grid=true) çıktısındaki tek kullanımlık screenshot_id ile WebView'a gerçek Android dokunuşu gönderir. DOM numarasıyla browser_click standart ve daha güvenilir yöntemdir; bu aracı canvas, harita, cross-origin iframe veya seçiciyle bulunamayan görsel kontroller için kullanın. Ya cell ('H12') ve isteğe bağlı hücre içi x_ratio/y_ratio, ya da görüntü pikseli olarak x/y verin. Sayfa adresi, kaydırma, görünür alan veya 30 saniyelik süre değiştiyse stale_screenshot ile reddeder. <select>, disabled ve dosya yükleme alanları güvenli alternatifleriyle birlikte reddedilir. Yanıt tıklanan öğeyi ve sayfadaki etkiyi bildirir.",
        inputSchema: {
            type: "object",
            properties: {
                screenshot_id: { type: "string", description: "browser_screenshot(grid=true) yanıtındaki tek kullanımlık görüntü kimliği." },
                cell: { type: "string", pattern: "^[A-Za-z][0-9]{1,2}$", description: "Grid hücresi, örn. H12. Verilirse x/y vermeyin." },
                x_ratio: { type: "number", minimum: 0, maximum: 1, description: "cell içinde soldan konum; varsayılan 0.5 (merkez). Küçük hedeflerde hassaslaştırır." },
                y_ratio: { type: "number", minimum: 0, maximum: 1, description: "cell içinde yukarıdan konum; varsayılan 0.5 (merkez)." },
                x: { type: "number", minimum: 0, description: "Dönen JPEG üzerindeki kesin x pikseli. cell ile birlikte kullanmayın." },
                y: { type: "number", minimum: 0, description: "Dönen JPEG üzerindeki kesin y pikseli. cell ile birlikte kullanmayın." },
                tabId: { type: "string", description: "Opsiyonel; görüntünün sekmesi kimlikten otomatik bulunur." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["screenshot_id"]
        }
    },
    {
        name: "browser_press_key",
        description: "Odaktaki (veya belirtilen) öğeye bir tuş gönderir: 'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace' gibi. Otomatik tamamlama akışlarının vazgeçilmezi: alana yazdıktan sonra açılan listeden seçmek için ArrowDown + Enter gönderin. 'Enter' bir form alanındayken ve sayfa olayı iptal etmediyse form ayrıca gönderilir ('form_submitted' alanına bakın). Yanıt, tıklamada olduğu gibi etkiyi de bildirir.",
        inputSchema: {
            type: "object",
            properties: {
                key: { type: "string", description: "Tuş adı: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, PageUp, PageDown" },
                selector: { type: "string", description: "(Opsiyonel) Tuşun gönderileceği öğe. Boş bırakılırsa sayfadaki odaklı öğeye gider — genelde az önce yazdığınız alan." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["key"]
        }
    },
    {
        name: "browser_wait_for",
        description: "Bir öğe görünene veya bir metin sayfada belirene kadar bekler. Tıklamadan sonra sonuçların yüklenmesini beklemek için kullanın; sabit sürelerle tahmin yürütmekten iyidir. Süre dolarsa hata değil 'timeout' durumu döner — bu, beklediğiniz şeyin gelmediği bilgisidir; aynı beklemeyi tekrarlamak yerine sayfayı okuyun.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Beklenecek CSS seçici veya element ID sayısı." },
                text: { type: "string", description: "Sayfada görünmesi beklenen metin (büyük/küçük harf duyarsız)." },
                timeout_ms: { type: "integer", minimum: 500, maximum: 20000, description: "En fazla bekleme süresi. Varsayılan 8000." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_execute_js",
        description: "Sayfada özel bir JavaScript kodu çalıştırır ve sonucunu döner. Bu yetki cihazda varsayılan olarak KAPALIDIR; kullanıcı telefondan 'execute_js' iznini açmadıkça çağrı reddedilir.",
        inputSchema: {
            type: "object",
            properties: {
                script: { type: "string", description: "Çalıştırılacak JS kod satırı" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["script"]
        }
    },
    {
        name: "browser_type",
        description: "Bir alana metin yazar. Yazma gerçek bir klavye gibi davranır: değer, çatının (React/Vue) kendi izleyicisini fark edeceği şekilde yerel setter üzerinden yazılır ve tuş olayları gönderilir. Arama/otomatik tamamlama görünümlü alanlarda karakter karakter yazılır, çünkü bu alanlar öneri listesini tuş olaylarıyla açar — tek seferde değer atamak listeyi hiç açmaz ve form geçerli bir seçim almamış olur. Yanıtta bir öneri listesi belirdiyse 'suggestions' alanında gelir; oradan numarasıyla tıklayabilir veya ArrowDown + Enter gönderebilirsiniz. Şifre, doğrulama kodu ve ödeme alanları ayrı bir izne bağlıdır.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Markdown çıktısındaki element ID sayısı veya CSS seçici" },
                text: { type: "string", description: "Yazılacak metin. Alan doluysa önce temizlenir." },
                keystroke: { type: "boolean", description: "true verilirse alan arama görünümlü olmasa da karakter karakter yazılır. Öneri listesi açılmıyorsa bunu deneyin." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector", "text"]
        }
    },
    {
        name: "browser_select_option",
        description: "Bir açılır listede (<select>) seçenek seçer. **Açılır listeler için 'browser_click' kullanmayın**: bir <select>'e tıklamak Android'in kendi seçicisini açar, o pencere sayfanın parçası değildir ve ajan oradan seçim yapamaz — tıklama başarılı görünür ama değer hiç değişmez. Bu araç seçimi doğrudan yapar ve sayfanın 'change' olayını görmesini sağlar. Seçeneğin görünen metnini 'label' ile verin; büyük/küçük harf ve Türkçe karakter farkı önemsizdir. Eşleşme bulunamazsa yanıt mevcut seçenekleri listeler. role=\"listbox\" ile kurulmuş özel menülerde de çalışır, ama önce menünün açık olması gerekir.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Listenin element ID sayısı (markdown çıktısındaki 'Select #12') veya CSS seçici." },
                label: { type: "string", description: "Seçilecek seçeneğin görünen metni, ör. 'Türkiye'." },
                value: { type: "string", description: "(Opsiyonel) option etiketinin value değeri; 'label' yerine kullanılabilir." },
                index: { type: "integer", description: "(Opsiyonel) Seçeneğin sıra numarası (0'dan başlar)." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector"]
        }
    },
    {
        name: "browser_pick_date",
        description: "Bir tarih seçer — hem gerçek tarih alanlarında (input type=date) hem de rezervasyon ve uçuş sitelerinin çizdiği takvim bileşenlerinde. Tarihi her zaman YYYY-AA-GG biçiminde verin (ör. '2026-09-15'). Takvim hücrelerinin çoğu ekranda yalnızca gün sayısını gösterir; hangi aya ait olduğunu cihaz çözer, istenen aya kendisi ilerler — takvim ay/yıl açılır listesi sunuyorsa tek adımda oradan, sunmuyorsa ay oklarına basarak — ve doğru hücreye tıklar. Doğum tarihi gibi uzak tarihler de bu yüzden tek çağrıda seçilebilir. Takvim kapalıysa 'selector' olarak tarih alanının numarasını verin, önce o açılır. Gün doluysa/kapalıysa ya da tarih takvimin izin verdiği aralığın dışındaysa yanıt bunu ve görünen aralığı söyler — aynı çağrıyı tekrarlamak yardımcı olmaz.",
        inputSchema: {
            type: "object",
            properties: {
                date: { type: "string", description: "Seçilecek tarih, YYYY-AA-GG biçiminde. Örn. '2026-09-15'." },
                selector: { type: "string", description: "(Opsiyonel) Tarih alanının ya da takvimi açan öğenin element ID sayısı. Takvim zaten açıksa gerekmez." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["date"]
        }
    },
    {
        name: "browser_read_form",
        description: "Bir formun **güncel durumunu** döner: her alanın numarası, etiketi, tipi, içindeki değer, zorunlu mu, devre dışı/salt okunur mu, açılır listelerin seçenekleri ve varsa doğrulama hataları. Ayrıca hangi zorunlu alanların hâlâ boş olduğunu ('missing_required'), hangilerinin geçersiz olduğunu ('invalid_fields') ve sayfanın gösterdiği uyarıları ('alerts') verir. Form doldururken her adımdan sonra tüm sayfayı 'browser_get_markdown' ile yeniden okumak yerine bunu kullanın: birkaç yüz token tutar ve tam olarak gereken bilgiyi verir. Şifre, kart ve doğrulama kodu alanlarının değerleri okunmaz; yalnızca dolu/boş bilgisi döner.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "(Opsiyonel) Formun ya da içindeki bir alanın element ID sayısı / CSS seçicisi. Boş bırakılırsa sayfadaki en kapsamlı görünür form seçilir." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_fill_form",
        description: "Birden çok alanı tek komutta doldurur. Alan tipi otomatik anlaşılır: metin alanına yazar, açılır listede seçim yapar, onay kutusunu işaretler, gerçek tarih alanına tarihi yazar. Alan alan doldurmaya göre iki üstünlüğü var: tek tur sürer ve kişisel bilgi içeren bir formda kullanıcıya **tek bir onay** çıkar — arka arkaya on onay kutusu, kullanıcının onayları okumayı bırakmasına yol açar. Yanıt her alan için ayrı sonuç döner; doldurulamayanların nedeni 'results' içindedir. Şifre/ödeme alanları yine 'sensitive_fields' iznine bağlıdır. Takvim bileşenleri (gerçek input type=date olmayanlar) bu araçla doldurulamaz; onlar için 'browser_pick_date' kullanın.",
        inputSchema: {
            type: "object",
            properties: {
                fields: {
                    type: "array",
                    description: "Doldurulacak alanlar; en fazla 30 tane.",
                    items: {
                        type: "object",
                        properties: {
                            selector: { type: "string", description: "Alanın element ID sayısı veya CSS seçicisi." },
                            value: { type: "string", description: "Yazılacak değer. Açılır listede seçeneğin görünen metni, onay kutusunda 'true'/'false', tarih alanında YYYY-AA-GG." }
                        },
                        required: ["selector", "value"]
                    }
                },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["fields"]
        }
    },
    {
        name: "browser_handle_dialog",
        description: "Sayfanın açacağı **bir sonraki** tarayıcı iletişim kutusunun (alert / confirm / prompt) nasıl yanıtlanacağını önceden belirler. Bu kutular sayfanın JavaScript'ini bloke eder: biri açıkken hiçbir komut çalışamaz ve hiçbir yanıt dönemez, bu yüzden karar kutu açılmadan verilir. Varsayılan davranış: 'alert' kabul edilir, 'confirm' ve 'prompt' reddedilir. Bir işlemin yanıtında 'dialog' alanını gördüyseniz ve farklı yanıtlamak istiyorsanız bu aracı çağırıp aynı işlemi tekrarlayın. Ayar 2 dakika ya da ilk kullanım kadar geçerlidir.",
        inputSchema: {
            type: "object",
            properties: {
                accept: { type: "boolean", description: "true ise kutu kabul edilir (Tamam), false ise reddedilir (İptal). Varsayılan true." },
                text: { type: "string", description: "(Opsiyonel) 'prompt' kutusuna yazılacak metin." },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_toggle_overlay",
        description: "Ekrandaki interaktif elementlerin üzerine Vimium-style görsel numaralandırma etiketleri (overlay) ekler veya kaldırır.",
        inputSchema: {
            type: "object",
            properties: {
                enabled: { type: "boolean", description: "Overlay açık (true) veya kapalı (false) olsun" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["enabled"]
        }
    },
    {
        name: "browser_new_tab",
        description: "Mevcut AI oturumunda yeni bir sekme açar.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Açılacak URL adresi (opsiyonel, varsayılan google.com)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_close_tab",
        description: "Mevcut AI oturumunda bir sekkeyi veya aktif sekkeyi kapatır.",
        inputSchema: {
            type: "object",
            properties: {
                tabId: { type: "string", description: "Kapatılacak sekme ID'si (opsiyonel, belirtilmezse aktif sekme kapatılır)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_list_tabs",
        description: "Bu AI oturumuna ait tüm açık sekmeleri listeler.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_switch_tab",
        description: "Belirtilen sekmeye geçiş yapar.",
        inputSchema: {
            type: "object",
            properties: {
                tabId: { type: "string", description: "Geçiş yapılacak sekme ID'si" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["tabId"]
        }
    },
    {
        name: "browser_list_shortcuts",
        description: "Hizmet yönetiminin AI tarayıcı görevleri için seçtiği önerilen siteleri, ne için uygun olduklarını anlatan kısa açıklamalarla kategori kategori döner. Daha az sayfa okuma ve etkileşimle daha hızlı sonuç ve daha düşük token tüketimi hedeflenir. Bunlar zorunlu değildir; AI istediği siteyi kullanabilir. Birini seçtiğinizde URL'yi yeniden yazmayın veya aramayın, affiliate parametrelerini korumak için shortcutId ile browser_open_shortcut çağırın. Sayfaya dokunmaz ve izin gerektirmez.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_open_shortcut",
        description: "browser_list_shortcuts sonucundan AI'nin kendisinin seçtiği önerilen siteyi shortcutId ile açar. Otomatik eşleştirme veya yönlendirme yapmaz. Adresi katalogdan telefon çözer; böylece affiliate URL'si ve parametreleri AI tarafından yeniden yazılmadan aynen kullanılır. Normal gezinme izni gerekir.",
        inputSchema: {
            type: "object",
            properties: {
                shortcutId: { type: "string", description: "browser_list_shortcuts sonucundaki sabit kısayol kimliği" },
                read: { type: "boolean", description: "true ise açılan sayfanın Markdown içeriğini aynı yanıtta döner" },
                offset: { type: "integer", minimum: 0, description: "read=true iken Markdown parçasının başlangıç karakteri" },
                tabId: { type: "string", description: "Hedef sekme ID'si (opsiyonel)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["shortcutId"]
        }
    },
    {
        name: "browser_get_session_info",
        description: "Mevcut tarayıcı oturumunun ve profilinin bilgilerini (Oturum ID, Güvenlik Token'ı, Çerez Durumu, İstemci Adı ve Sekme Sayısı) getirir.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_list_sessions",
        description: "Kendi oturumunuzu listeler. Oturum izolasyonu mimari olarak zorunludur: başka bir istemcinin veya kullanıcının oturumu hiçbir ayarla görünür hale gelmez.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_clear_session_data",
        description: "Kendi oturumunuzun çerezlerini, önbelleğini ve gezinti geçmişini temizler. Bu yetki cihazda varsayılan olarak KAPALIDIR ve yalnızca kendi profilinize uygulanabilir.",
        inputSchema: {
            type: "object",
            properties: {
                clearCookies: { type: "boolean", description: "Çerezleri sil (Varsayılan: true)" },
                clearCache: { type: "boolean", description: "Önbelleği sil (Varsayılan: true)" },
                clearHistory: { type: "boolean", description: "Geçmişi sil (Varsayılan: true)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    }
];

// Comprehensive Tool Documentation & Agent Playbooks Dictionary
const TOOL_DOCUMENTATION = {
    overview: {
        title: "Android Tarayıcı MCP Köprüsü - AI Ajanı Kullanım Rehberi (Agent Playbook & Skills)",
        description: "Bu sistem, gerçek bir Android cihazı üzerindeki donanım hızlandırmalı WebView ile çalışan yüksek performanslı Model Context Protocol (MCP) köprüsüdür. Yapay zeka ajanları gerçek tarayıcı ortamında arama yapabilir, sayfaları okuyabilir, form doldurabilir, butonlara tıklayabilir, sekme ve izole oturum yönetimi gerçekleştirebilir.",
        capabilities: [
            "Gerçek Android WebView ortamında tam JavaScript, DOM, CSS ve Canvas çalıştırma",
            "Multi-Profile Cookie İzolasyonu: Her AI istemcisine özel bağımsız çerez ve depolama alanı",
            "Cihaz üstü Markdown motoru ile anında temiz içerik çıkarma — sayfa hiçbir dış servise gönderilmez",
            "Vimium-Style Numaralandırılmış Görsel Overlay ile elementleri ID sayılarıyla seçme/tıklama",
            "Çoklu Sekme (Multi-Tab) yönetimi ve DOM kaynağı alma"
        ],
        security_note: "Her istemci cihaz tarafından üretilen kalıcı bir kimliğe ve kendi izole çerez profiline sabitlenmiştir. Profil veya oturum değiştirilemez. 'execute_js' ve 'clear_data' yetkileri varsayılan olarak kapalıdır; kullanıcı telefondan açmadıkça bu çağrılar reddedilir. Sahip olduğunuz izinleri 'browser_get_session_info' ile görebilirsiniz.",
        approval_note: "Bazı işlemler izniniz olsa bile cihaz sahibine sorulur: 'browser_execute_js', 'browser_clear_session_data' ve kişisel bilgi alanlarına (e-posta, telefon, adres, kimlik) yazma. Kullanıcı 30 saniye içinde yanıtlamazsa istek reddedilir — bu normaldir, aynı komutu döngüye sokmayın; kullanıcıya ne yapmak istediğinizi açıklayıp tekrar deneyin. Şifre, doğrulama kodu ve ödeme alanları ayrı bir izne ('sensitive_fields') bağlıdır: izin kapalıyken doldurulamaz, açıkken de varsayılan olarak her doldurma için ayrı onay istenir.",
        concurrency_note: "Aynı anda en fazla 3 komutunuz çalışabilir; dördüncü komut 'too_many_requests' hatasıyla reddedilir. Bu bir ceza değil, telefonun pilini ve belleğini koruyan bir sınır: yanıtları bekleyip devam edin. Onay bekleyen bir komut da yanıtlanana (veya 30 saniyede reddedilene) kadar sıradaki yerini korur.",
        takeover_note: "Kullanıcı bir sekmeyi 'devralabilir'. Devralınan sekmede okuma dahil hiçbir komut çalışmaz ve hata mesajı bunu açıkça söyler. Bu durumda 'browser_new_tab' ile başka bir sekmede çalışmaya devam edin. Hangi sekmelerin kullanıcıda olduğunu 'browser_get_session_info' yanıtındaki 'heldByUser' alanından görebilirsiniz.",
        meta_tool_note: "İstediğiniz zaman 'browser_get_tool_documentation' aracını çağırarak spesifik bir araç veya kategori hakkında detaylı kılavuz alabilirsiniz."
    },
    categories: {
        navigation: {
            name: "Sayfa Gezinme & Arama",
            tools: ["browser_navigate", "browser_reload", "browser_search", "browser_scroll", "browser_list_shortcuts", "browser_open_shortcut"]
        },
        interaction: {
            name: "Etkileşim, Tıklama & Form Doldurma",
            tools: ["browser_click", "browser_click_at", "browser_type", "browser_select_option", "browser_pick_date", "browser_read_form", "browser_fill_form", "browser_press_key", "browser_wait_for", "browser_handle_dialog", "browser_toggle_overlay", "browser_execute_js"]
        },
        content_extraction: {
            name: "İçerik Okuma",
            tools: ["browser_get_markdown", "browser_get_html", "browser_screenshot"]
        },
        tabs_and_sessions: {
            name: "Sekme & Oturum Bilgisi",
            tools: ["browser_new_tab", "browser_close_tab", "browser_list_tabs", "browser_switch_tab", "browser_get_session_info", "browser_clear_session_data"]
        },
        meta: {
            name: "Rehber & Dokümantasyon",
            tools: ["browser_get_tool_documentation", "browser_list_devices"]
        }
    },
    tools: {
        browser_get_tool_documentation: {
            name: "browser_get_tool_documentation",
            category: "meta",
            summary: "Tüm MCP araçlarının parametrelerini, kullanım şekillerini, örneklerini ve en iyi iş akışlarını döner.",
            parameters: {
                tool_name: "(Opsiyonel, String) Hakkında bilgi istenen aracın adı (örn. 'browser_click', 'browser_get_markdown', 'browser_type', 'all'). Boş bırakılırsa tüm araçların rehberi döner.",
                category: "(Opsiyonel, String) Kategori filtresi ('navigation', 'interaction', 'content_extraction', 'tabs_and_sessions', 'meta', 'all')."
            },
            best_practice: "Yeni bir göreve başlarken hangi araçları nasıl kombine edeceğinizi planlamak veya parametre isimlerini doğrulamak için ilk olarak bu aracı çağırın."
        },
        browser_list_devices: {
            name: "browser_list_devices",
            category: "meta",
            summary: "Bu AI bağlantısına bağlı Android cihazlarını ve çevrimiçi durumlarını listeler.",
            parameters: {},
            example_call: {},
            best_practice: "Birden fazla cihaz bağlıysa önce bu aracı çağırın, sonra tarayıcı aracına dönen deviceId değerini verin. Varsayılan cihaz çevrimiçiyse deviceId vermeden çağrı yapmak mevcut davranışı korur."
        },
        browser_navigate: {
            name: "browser_navigate",
            category: "navigation",
            summary: "Belirtilen web adresine (URL) gider ve sayfanın yüklenmesini başlatır.",
            parameters: {
                url: "(Zorunlu, String) Gidilecek tam web adresi (örn. 'https://en.wikipedia.org' veya 'https://news.ycombinator.com'). Her zaman protokolü (https://) ekleyin.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { url: "https://www.google.com" },
            best_practice: "Yanıt zaten sayfanın özetini taşır: gerçek adres, başlık, 'headings' listesi ve uzunluk. Önce ona bakın — aradığınız bölüm listede yoksa sayfayı hiç okumadan başka bir adrese geçebilirsiniz. Okumaya karar verirseniz 'browser_get_markdown' çağırın; içeriği kesin istiyorsanız baştan read=true verin ve bir turdan tasarruf edin."
        },
        browser_reload: {
            name: "browser_reload",
            category: "navigation",
            summary: "Aktif sekmedeki mevcut belgeyi tarayıcının gerçek yenileme işlemiyle yeniden yükler.",
            parameters: {
                read: "(Opsiyonel, Boolean) true ise yenilenen sayfanın Markdown içeriğini aynı yanıta ekler.",
                offset: "(Opsiyonel, Integer) read=true iken Markdown parçasının başlangıç karakteri.",
                tabId: "(Opsiyonel, String) Yenilenecek sekmenin ID'si.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { read: true },
            best_practice: "Bayat içerik, geçici ağ hatası veya kullanıcının yaptığı bir değişiklikten sonra aynı belgeyi yeniden istemek için kullanın. Yeni bir adrese gitmek için browser_navigate kullanın. CAPTCHA ve başarısız işlemlerde tekrar tekrar yenilemeyin."
        },
        browser_search: {
            name: "browser_search",
            category: "navigation",
            summary: "Google'da belirtilen anahtar kelimelerle doğrudan arama yapar.",
            parameters: {
                query: "(Zorunlu, String) Aranacak kelime veya cümle (örn. '2026 en iyi yapay zeka modelleri')",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { query: "İstanbul hava durumu" },
            best_practice: "Arama yanıtındaki 'headings' listesi çoğu zaman sonuç başlıklarını verir; tam listeyi ve linkleri okumak için 'browser_get_markdown' çağırın veya read=true kullanın."
        },
        browser_get_markdown: {
            name: "browser_get_markdown",
            category: "content_extraction",
            summary: "Açık olan sayfanın Markdown içeriğini döner. Dönüşüm cihazda yapılır; çıktı tıklanabilir öğelerin numaralandırıldığı bir etkileşim haritasıdır.",
            parameters: {
                offset: "(Opsiyonel, Integer) Token tasarrufu açıkken ilk çağrıda 0; devam çağrısında önceki next_offset değeri.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "İçerik okumanın tek ve varsayılan yoludur: hızlı, cihazda çalışır, sayfayı hiçbir dış servise göndermez. Çıktının başındaki element ID sayılarını doğrudan 'browser_click' ve 'browser_type' ile kullanın. has_more true ise aynı aracı next_offset ile çağırın; sayfayı baştan okumayın. Ham kaynak gerekiyorsa 'browser_get_html' ayrı bir araçtır."
        },
        browser_get_html: {
            name: "browser_get_html",
            category: "content_extraction",
            summary: "Sayfanın ham outerHTML kaynağını döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Spesifik DOM elementlerini, form input id/name etiketlerini veya karmaşık CSS seçicilerini bulmak gerektiğinde kullanın."
        },
        browser_screenshot: {
            name: "browser_screenshot",
            category: "content_extraction",
            summary: "Sekmenin JPEG görüntüsünü MCP görüntü bloğu olarak döner. Uygulama telefonda açıkken arka plandaki sekmeler için de çalışır: cihaz sekmeyi bir anlığına ekrana alıp geri döner.",
            parameters: {
                fullPage: "(Opsiyonel, Boolean) Varsayılan false. true ise sayfanın tamamı yakalanır.",
                grid: "(Opsiyonel, Boolean) true ise görünür alanı etiketli hücrelere böler ve browser_click_at için screenshot_id üretir.",
                grid_columns: "(Opsiyonel, Integer) 4–26; varsayılan 15.",
                grid_rows: "(Opsiyonel, Integer) 4–40; varsayılan 24.",
                tabId: "(Opsiyonel, String) Hedef sekme; verilmezse oturumun aktif sekmesi.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Sayfanın yapısını anlamak için önce browser_get_markdown kullanın. Seçiciyle bulunamayan canvas, harita veya iframe kontrolü için grid=true ile görünür alanı alın ve dönen screenshot_id'yi hemen browser_click_at ile kullanın. Hücrenin merkezi küçük hedefi kaçırıyorsa x_ratio/y_ratio verin ya da görüntüdeki kesin x/y pikselini kullanın. Grid ile fullPage birlikte kullanılmaz.",
            limitations: "Uygulama ön planda değilken hiçbir sekme çizilmez ve 'blank_capture' döner; bu durumda içeriği metin olarak okuyun. Ekrana alma birkaç yüz milisaniye sürer ve kullanıcının ekranı o an kısaca değişir, bu yüzden döngü içinde çağırmayın. Aynı anda yalnızca bir ekrana alma yapılabilir. Tam sayfa yakalama yalnızca ekran dışı çizimde mümkündür; ekrana alınarak çekilen görüntülerde yalnızca görünen alan gelir. Görüntü 720 piksel genişliğe ölçeklenir ve JPEG olarak sıkıştırılır. Video, WebGL ve GPU ile birleştirilen bazı canvas içerikleri boş çıkabilir."
        },
        browser_select_option: {
            name: "browser_select_option",
            category: "interaction",
            summary: "Açılır listede (<select>) seçenek seçer — tıklamayla yapılamayan tek işlem.",
            parameters: {
                selector: "(Zorunlu, String) Listenin element ID sayısı veya CSS seçici.",
                label: "(String) Seçeneğin görünen metni. Büyük/küçük harf ve Türkçe karakter farkı önemsizdir.",
                value: "(Opsiyonel, String) option değeri.",
                index: "(Opsiyonel, Integer) Seçeneğin sırası, 0'dan başlar."
            },
            example_call: { selector: "12", label: "Türkiye" },
            best_practice: "Bir <select>'e asla 'browser_click' göndermeyin: Android'in kendi seçicisi açılır, o pencere sayfanın parçası değildir ve seçim yapılamaz — tıklama başarılı görünürken değer değişmez. Seçenekleri markdown çıktısında liste satırında ya da 'browser_read_form' yanıtında görebilirsiniz. Özel (role=listbox) menülerde önce menüyü 'browser_click' ile açın."
        },
        browser_pick_date: {
            name: "browser_pick_date",
            category: "interaction",
            summary: "Takvimden ya da tarih alanından bir tarih seçer; gerekirse doğru aya kendisi ilerler.",
            parameters: {
                date: "(Zorunlu, String) YYYY-AA-GG biçiminde tarih, ör. '2026-09-15'.",
                selector: "(Opsiyonel, String) Tarih alanının ya da takvimi açan öğenin element ID sayısı."
            },
            example_call: { date: "2026-09-15", selector: "34" },
            best_practice: "Rezervasyon sitelerinde takvim hücreleri ekranda yalnızca gün sayısını gösterir; hangi ay olduğunu tahmin etmeyin, bu aracı kullanın. Takvim kapalıysa 'selector' verin. Gidiş-dönüş gibi aralık seçen takvimlerde aracı iki kez çağırın: ilk çağrı aralığın başını, ikincisi sonunu seçer. Yanıt 'seçilemez' ya da 'aralık dışında' diyorsa tarih gerçekten yoktur — tekrar denemek yerine kullanıcıya durumu söyleyin."
        },
        browser_read_form: {
            name: "browser_read_form",
            category: "content_extraction",
            summary: "Yalnızca formu okur: alanlar, değerler, zorunlular, seçenekler ve hatalar.",
            parameters: {
                selector: "(Opsiyonel, String) Formun ya da içindeki bir alanın element ID sayısı / CSS seçicisi."
            },
            example_call: {},
            best_practice: "Form doldururken her adımdan sonra bunu çağırın, 'browser_get_markdown' değil: tüm sayfayı yeniden okumak bir rezervasyon sayfasında on binlerce token tutar ve pahalı olduğu için atlanır — atlanınca da form körlemesine doldurulur. 'missing_required' hangi alanların kaldığını, 'invalid_fields' sayfanın neye itiraz ettiğini söyler."
        },
        browser_fill_form: {
            name: "browser_fill_form",
            category: "interaction",
            summary: "Birden çok alanı tek komutta, tek onayla doldurur.",
            parameters: {
                fields: "(Zorunlu, Array) [{selector, value}] listesi, en fazla 30 öğe. Alan tipi otomatik anlaşılır."
            },
            example_call: { fields: [{ selector: "5", value: "Ayşe" }, { selector: "6", value: "ayse@example.com" }, { selector: "9", value: "Türkiye" }] },
            best_practice: "Kayıt ve rezervasyon formlarında varsayılan yol budur: tek tur, tek onay. Alan alan doldurmak hem yavaştır hem de kişisel bilgi alanlarında arka arkaya onay kutusu çıkarır. Şehir/havalimanı gibi öneri listesi açan alanlar istisnadır — onları 'browser_type' ile yazıp listeden seçin. Doldurduktan sonra göndermeden önce 'browser_read_form' ile doğrulayın."
        },
        browser_handle_dialog: {
            name: "browser_handle_dialog",
            category: "interaction",
            summary: "Bir sonraki alert/confirm/prompt kutusunun yanıtını önceden ayarlar.",
            parameters: {
                accept: "(Opsiyonel, Boolean) true = kabul, false = reddet. Varsayılan true.",
                text: "(Opsiyonel, String) 'prompt' kutusuna yazılacak metin."
            },
            example_call: { accept: true },
            best_practice: "Kutu açıkken sayfanın JavaScript'i durur, dolayısıyla o anda hiçbir komut çalışmaz — bu yüzden karar önceden verilir. Varsayılan: 'alert' kabul, 'confirm'/'prompt' ret. Bir yanıtta 'dialog' alanı gördüyseniz ve sonucu değiştirmek istiyorsanız bu aracı çağırıp aynı işlemi tekrarlayın."
        },
        browser_toggle_overlay: {
            name: "browser_toggle_overlay",
            category: "interaction",
            summary: "Ekrandaki tüm interaktif elementlerin üzerine Vimium-style görsel numaralandırma etiketleri ekler/kaldırır.",
            parameters: {
                enabled: "(Zorunlu, Boolean) true (etiketleri aç) veya false (kapat)"
            },
            best_practice: "Form doldururken veya karmaşık bir sayfada tıklama yaparken önce overlay'i açın, ardından 'browser_get_markdown' çıktısındaki element ID sayılarını tespit edip doğrudan ID numarasıyla ('1', '2' vb.) tıklayın."
        },
        browser_click: {
            name: "browser_click",
            category: "interaction",
            summary: "Bir öğeye gerçek işaretçi dizisiyle tıklar ve etkisini bildirir.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı veya CSS seçici.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Yanıttaki 'page_changed' alanına bakın. False ise öğe bulunmuş ama bir şey olmamıştır — aynı tıklamayı tekrarlamak yardımcı olmaz; sayfayı yeniden okuyup başka bir öğe deneyin. 'suggestions' geldiyse bir liste açılmıştır, listeden seçin. 'new_url' geldiyse element numaraları geçersizdir, devam etmeden önce sayfayı yeniden okuyun."
        },
        browser_click_at: {
            name: "browser_click_at",
            category: "interaction",
            summary: "Gridli ekran görüntüsündeki hücreye veya piksele gerçek Android dokunuşu gönderir.",
            parameters: {
                screenshot_id: "(Zorunlu, String) grid=true ekran görüntüsünün 30 saniyelik, tek kullanımlık kimliği.",
                cell: "(String) A1..O24 gibi hücre etiketi; kullanılan grid yoğunluğuna göre son etiket değişir.",
                x_ratio: "(Opsiyonel, Number) Hücre içinde soldan 0–1; varsayılan 0.5.",
                y_ratio: "(Opsiyonel, Number) Hücre içinde yukarıdan 0–1; varsayılan 0.5.",
                x: "(Number) JPEG üzerindeki kesin x pikseli; cell ile birlikte verilmez.",
                y: "(Number) JPEG üzerindeki kesin y pikseli; cell ile birlikte verilmez."
            },
            example_call: { screenshot_id: "shot_abc123", cell: "H12", x_ratio: 0.7, y_ratio: 0.35 },
            best_practice: "Önce DOM numarasıyla browser_click kullanın. Bu araç görsel yedektir. Ekran görüntüsünü aldıktan hemen sonra çağırın; sayfa kaydıysa veya değiştiyse yeni görüntü alın. Aynı screenshot_id ikinci kez kullanılamaz. Yanıttaki label/tag ve page_changed alanları gerçek hedefi ve etkiyi doğrular."
        },
        browser_press_key: {
            name: "browser_press_key",
            category: "interaction",
            summary: "Enter, Escape, Tab veya ok tuşlarını gönderir.",
            parameters: {
                key: "(Zorunlu, String) Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace …",
                selector: "(Opsiyonel, String) Hedef öğe; boşsa odaktaki öğeye gider.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Otomatik tamamlama akışının ikinci yarısı budur: 'browser_type' ile yazın, yanıtta 'suggestions' gelirse ArrowDown ve Enter gönderin. Arama kutusunda Enter formu da gönderir; 'form_submitted' alanı bunu doğrular."
        },
        browser_wait_for: {
            name: "browser_wait_for",
            category: "interaction",
            summary: "Bir öğe veya metin görünene kadar bekler.",
            parameters: {
                selector: "(Opsiyonel, String) Beklenecek seçici veya element numarası.",
                text: "(Opsiyonel, String) Beklenecek metin.",
                timeout_ms: "(Opsiyonel, Integer) 500–20000 arası, varsayılan 8000.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Arama sonuçları, uçuş listeleri ve giriş sonrası yönlendirmeler için kullanın. 'timeout' dönerse beklediğiniz şey gelmemiştir; tekrar beklemek yerine sayfayı okuyup gerçekte ne olduğunu görün."
        },
        browser_type: {
            name: "browser_type",
            category: "interaction",
            summary: "Bir alana klavye gibi yazar; arama alanlarında karakter karakter gider.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı veya CSS seçici.",
                text: "(Zorunlu, String) Yazılacak metin.",
                keystroke: "(Opsiyonel, Boolean) Karakter karakter yazmayı zorlar.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Uçuş, otel ve şehir alanlarında metnin görünmesi yetmez — form geçerli bir seçim bekler. Yazdıktan sonra yanıttaki 'suggestions' listesine bakın ve mutlaka birini seçin; liste boşsa 'keystroke' true ile tekrar deneyin, sonra 'browser_wait_for' ile listenin gelmesini bekleyin."
        },
        browser_execute_js: {
            name: "browser_execute_js",
            category: "interaction",
            summary: "Sayfa bağlamında özel JavaScript kodu çalıştırır ve sonucunu döner.",
            parameters: {
                script: "(Zorunlu, String) Çalıştırılacak JS kodu (örn. 'document.title' veya 'window.location.href')"
            },
            best_practice: "Özel DOM sorguları, çerez okuma, sayfa içi hesaplamalar veya karmaşık tetikleyiciler için kullanın. Bu araç varsayılan olarak her çağrıda telefonda kullanıcı onayı ister (30 saniyede yanıt yoksa reddedilir), bu yüzden onu bir döngü içinde değil, tek ve amaçlı çağrılarla kullanın."
        },
        browser_new_tab: {
            name: "browser_new_tab",
            category: "tabs_and_sessions",
            summary: "Oturumunuzda yeni bir sekme açar. Oturumun ilk sekmesinde yanıt, yönetimin isteğe bağlı site önerilerini de taşır.",
            parameters: {
                url: "(Opsiyonel, String) Açılışta gidilecek adres.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Yanıttaki siteler yönetimin AI görevleri için seçtiği isteğe bağlı önerilerdir. AI bunlarla sınırlı değildir. Birini seçerseniz adresi yeniden yazmak yerine shortcutId ile browser_open_shortcut kullanın."
        },
        browser_close_tab: {
            name: "browser_close_tab",
            category: "tabs_and_sessions",
            summary: "Belirtilen veya aktif olan sekmeyi kapatır.",
            parameters: {
                tabId: "(Opsiyonel, String) Kapatılacak sekme ID'si."
            }
        },
        browser_list_tabs: {
            name: "browser_list_tabs",
            category: "tabs_and_sessions",
            summary: "Bu AI oturumuna ait açık tüm sekmeleri başlıkları ve URL'leri ile listeler.",
            parameters: {}
        },
        browser_switch_tab: {
            name: "browser_switch_tab",
            category: "tabs_and_sessions",
            summary: "Belirtilen sekmeye geçiş yapar ve aktif sekme haline getirir.",
            parameters: {
                tabId: "(Zorunlu, String) Hedef sekme ID'si."
            }
        },
        browser_list_shortcuts: {
            name: "browser_list_shortcuts",
            category: "navigation",
            summary: "Hizmet yönetiminin AI görevleri için seçtiği isteğe bağlı site önerilerini döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Göreve uygun bir öneri varsa kullanabilirsiniz; zorunlu değildir. Seçtiğiniz kaydın URL'sini kopyalamak yerine shortcutId ile browser_open_shortcut kullanın; bu affiliate parametrelerini aynen korur."
        },
        browser_open_shortcut: {
            name: "browser_open_shortcut",
            category: "navigation",
            summary: "AI'nin seçtiği yönetim önerisini, kayıtlı adresini yeniden yazmadan açar.",
            parameters: {
                shortcutId: "(Zorunlu, String) browser_list_shortcuts sonucundaki kısayol kimliği.",
                read: "(Opsiyonel, Boolean) true ise sayfa Markdown içeriğini aynı yanıta ekler.",
                offset: "(Opsiyonel, Integer) read=true iken Markdown başlangıç karakteri.",
                tabId: "(Opsiyonel, String) Hedef sekme ID'si."
            },
            best_practice: "Bu araç bir siteyi kendiliğinden seçmez. Önce browser_list_shortcuts sonucundan uygun kaydı siz seçin. URL'yi browser_navigate içine kopyalamayın; affiliate bağlantısının aynen açılması için shortcutId kullanın."
        },
        browser_get_session_info: {
            name: "browser_get_session_info",
            category: "tabs_and_sessions",
            summary: "Kendi oturumunuzun kimliğini, adını, açık sekme sayısını, cihazın size verdiği izinleri, ekran modunu ('viewMode') ve kullanıcının devraldığı sekmeleri ('heldByUser') döner.",
            parameters: {},
            best_practice: "Bir işe başlamadan önce hangi izinlere sahip olduğunuzu buradan doğrulayın; kapalı bir yetkiyi çağırmak yerine kullanıcıdan telefondan açmasını isteyin. Bir sekme yanıt vermiyorsa 'heldByUser' listesine bakın: kullanıcı o sekmeyi devralmış olabilir."
        },
        browser_list_sessions: {
            name: "browser_list_sessions",
            category: "tabs_and_sessions",
            summary: "Yalnızca kendi oturumunuzu döner. Oturumlar arası görünürlük diye bir seçenek yoktur.",
            parameters: {},
            best_practice: "Aynı oturumu paylaşmanız gerekiyorsa cihaz sahibi aynı istemci anahtarını birden fazla MCP istemcisine tanımlar; oturum değiştirme diye bir işlem yoktur."
        },
        browser_clear_session_data: {
            name: "browser_clear_session_data",
            category: "tabs_and_sessions",
            summary: "Kendi profilinizin çerezlerini, önbelleğini ve gezinti geçmişini temizler.",
            parameters: {
                clearCookies: "(Opsiyonel, Boolean) Varsayılan: true",
                clearCache: "(Opsiyonel, Boolean) Varsayılan: true",
                clearHistory: "(Opsiyonel, Boolean) Varsayılan: true"
            },
            best_practice: "'clear_data' izni varsayılan olarak kapalıdır ve izin açık olsa bile her çağrıda telefonda kullanıcı onayı istenir; 30 saniyede yanıt gelmezse reddedilir. Yalnızca kendi profilinize uygulanır; başka bir oturumun verisi silinemez."
        }
    },
    playbooks: [
        {
            title: "Form ve rezervasyon sitelerinde çalışma",
            steps: [
                "1. Sayfaya gidin; yanıttaki 'headings' ile doğru yerde olduğunuzu doğrulayın. Yanıtlarda 'consent_wall' görürseniz forma girişmeden önce onu kapatın — bant hem ekranı hem tıklamaları örter. Kullanıcı aksini söylemediyse 'reject_id' ile en az veri paylaşan seçeneği kullanın; 'accept_id' yalnızca reddetme düğmesi bulunamadığında kalır.",
                "2. 'browser_get_markdown' çağırın — element numaraları bu geçişte atanır, öncesinde numarayla tıklayamazsınız. Bağlantılardaki fiil hangi aracı kullanacağınızı söyler: type: / select: / pick_date: / click:.",
                "3. Formun tam durumunu 'browser_read_form' ile alın: zorunlu alanlar, açılır liste seçenekleri ve devre dışı alanlar buradadır. Bundan sonra her adımda tüm sayfayı değil bunu okuyun.",
                "4. Sıradan alanları tek seferde doldurun: 'browser_fill_form' (tek tur, tek onay).",
                "5. Açılır listeler için 'browser_select_option'. Bir <select>'e asla tıklamayın — Android'in kendi seçicisi açılır ve ajan oradan seçim yapamaz.",
                "6. Tarihler için 'browser_pick_date' (YYYY-AA-GG). Takvim hücreleri ekranda sadece gün sayısı gösterir; ay tahmin etmeyin.",
                "7. Şehir/havalimanı gibi öneri listesi açan alanlar istisnadır: 'browser_type' ile karakter karakter yazılır, sonra yanıttaki 'suggestions' listesinden numarayla 'browser_click' ya da 'browser_press_key' ile ArrowDown + Enter.",
                "8. Göndermeden önce 'browser_read_form' ile doğrulayın: 'missing_required' boşsa form tamamdır.",
                "9. Gönderdikten sonra yanıttaki 'invalid_fields' ve 'alerts' alanlarına bakın — sayfa formu neden kabul etmediğini (hatalı giriş, geçersiz alan) orada söyler. Yanıt sayfanın yeni içerik yüklediğini söylüyorsa gönderim gitmiştir: düğmeye tekrar basmayın, 'browser_wait_for' ile bekleyip sonucu okuyun. 'page_changed' false ve bu alanlar da boşsa gerçekten ilerlememişsinizdir; aynı adımı tekrarlamak yardımcı olmaz.",
                "10. Sonuçların yüklenmesini 'browser_wait_for' ile bekleyin. Bir onay kutusu ('dialog') çıktıysa 'browser_handle_dialog' ile yanıtı ayarlayıp adımı tekrarlayın.",
                "11. Yanıtta 'captcha' alanı görürseniz sayfa insan doğrulaması istiyor demektir. Cihaz sayfayı sizin için bir kez yeniler; doğrulama yine duruyorsa çözmeye çalışmayın — denemeler engeli sertleştirir ve o sayfadan okuduğunuz içerik eksik olur. Kullanıcıya durumu söyleyip telefondan doğrulamayı kendisinin tamamlamasını isteyin, sonra adımı tekrarlayın."
            ]
        },
        {
            title: "İş Akışı 1: Web Araması ve Bilgi Toplama (Research & Extract)",
            steps: [
                "1. 'browser_search(query: \"...\")' çağırarak arama yapın.",
                "2. 'browser_get_markdown()' çağırarak arama sonuçlarını ve linkleri okuyun.",
                "3. İlgili bir sonuca gitmek için 'browser_navigate(url: \"...\")' veya 'browser_click(selector: \"text=...\")' çağırın.",
                "4. Hedef sayfadaki tam içeriği 'browser_get_markdown()' ile çekip kullanıcıya özetleyin."
            ]
        },
        {
            title: "İş Akışı 2: Form Doldurma ve Buton Tıklama (Form Filling & Automation)",
            steps: [
                "1. 'browser_navigate(url: \"...\")' ile sayfayı açın.",
                "2. 'browser_type(selector: \"input[name='username']\", text: \"...\")' ile inputları doldurun.",
                "3. Butona tıklamak için 'browser_click(selector: \"text=Giriş Yap\")' veya CSS seçici kullanın.",
                "4. İşlemin sonucunu doğrulamak için 'browser_get_markdown()' çağırın."
            ]
        },
        {
            title: "İş Akışı 3: Numaralandırılmış Element ile Hassas Tıklama",
            steps: [
                "1. 'browser_toggle_overlay(enabled: true)' ile interaktif elementlerin üzerine numaralandırma etiketlerini yerleştirin.",
                "2. 'browser_get_markdown()' çağırarak çıktının başındaki 'İnteraktif Elementler Tablosu'ndan ID numaralarını okuyun.",
                "3. Hedef elementin numarasını (örn. '5') 'browser_click(selector: \"5\")' ile doğrudan tıklayın.",
                "4. İşi bitirince 'browser_toggle_overlay(enabled: false)' ile overlay'i kapatın."
            ]
        },
        {
            title: "İş Akışı 4: Paralel Görevler & Sekme İzolasyonu (Multi-Tab Management)",
            steps: [
                "1. Mevcut sayfayı bozmamak için 'browser_new_tab(url: \"https://...\")' çağırın.",
                "2. Yeni sekmede işlemlerinizi yürütün.",
                "3. İşiniz bittiğinde 'browser_close_tab()' ile kapatın veya 'browser_switch_tab(tabId: \"...\")' ile önceki sekmeye dönün."
            ]
        }
    ]
};

function generateDocumentationResponse(toolName = 'all', category = 'all') {
    const cleanTool = (toolName || 'all').trim().toLowerCase();
    const cleanCat = (category || 'all').trim().toLowerCase();

    if (cleanTool !== 'all' && TOOL_DOCUMENTATION.tools[cleanTool]) {
        const doc = TOOL_DOCUMENTATION.tools[cleanTool];
        return {
            status: "success",
            requested_tool: cleanTool,
            documentation: doc,
            meta_info: "Tüm araçların ve iş akışlarının tam listesini görmek için tool_name: 'all' parametresi ile çağırabilirsiniz.",
            formatted_text: `### 🛠️ Araç Rehberi: ${doc.name}\n- **Kategori:** ${doc.category}\n- **Özet:** ${doc.summary}\n- **Parametreler:**\n${Object.entries(doc.parameters).map(([k, v]) => `  - \`${k}\`: ${v}`).join('\n')}\n- **En İyi Kullanım (Best Practice):** ${doc.best_practice}\n${doc.example_call ? `- **Örnek Çağrı:** \`${JSON.stringify(doc.example_call)}\`\n` : ''}`
        };
    }

    let filteredTools = Object.values(TOOL_DOCUMENTATION.tools);
    if (cleanCat !== 'all') {
        filteredTools = filteredTools.filter(t => t.category === cleanCat);
    }

    return {
        status: "success",
        overview: TOOL_DOCUMENTATION.overview,
        category_filter: cleanCat,
        total_tools: filteredTools.length,
        tools: filteredTools,
        playbooks: TOOL_DOCUMENTATION.playbooks,
        quick_tip: "Herhangi bir aracın spesifik detayını almak için: browser_get_tool_documentation(tool_name: 'araç_adı') çağırabilirsiniz."
    };
}

// ----------------------------------------------------
// CREDENTIALS
// A credential is "<clientId>.<secret>". The clientId routes the call to the
// original/default phone or an explicitly selected bound phone. The secret is
// verified here against the stored hash AND again on the destination device,
// which remains the actual authority.
// ----------------------------------------------------
function parseCredential(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0 || dot === value.length - 1) return null;
    return { clientId: value.substring(0, dot), secret: value.substring(dot + 1) };
}

function extractCredential(req) {
    const header = req.headers['authorization'] || '';
    let raw = '';
    if (header) {
        raw = header.toLowerCase().startsWith('bearer ') ? header.substring(7).trim() : header.trim();
    }
    // Deliberately not `req.query.token`. A secret in a query string ends up in
    // the platform's access logs, in every proxy between here and the client,
    // and in browser history — and the relay cannot un-log any of them. The
    // header is the only way in.
    if (!raw) raw = req.headers['x-mcp-token'] || '';
    return parseCredential(raw);
}

// Returns { ok, clientId, secret, record } or { ok:false, reason }
function authenticate(req) {
    const cred = extractCredential(req);
    if (!cred) return { ok: false, reason: 'missing' };
    const record = clients.get(cred.clientId);
    if (!record) return { ok: false, reason: 'unknown' };
    if (!safeEquals(sha256(cred.secret), record.secretHash)) return { ok: false, reason: 'bad_secret' };
    const account = record.accountId ? accountCache.get(record.accountId) || null : null;
    return { ok: true, clientId: cred.clientId, secret: cred.secret, record, account };
}

/**
 * Guards an MCP entry point.
 *
 * Three things happen here that did not before:
 *
 * 1. A wrong credential is counted per IP. Without that, a valid `clientId` is
 *    findable by trying secrets at line speed, and nothing anywhere would say
 *    so.
 * 2. A suspended account's keys stop working. Suspension that only takes effect
 *    at the next pairing is not suspension.
 * 3. The account is attached to the result, so everything downstream — quota,
 *    audit scoping, the panel — has it without another lookup.
 */
function requireAuth(req, res) {
    const ip = limits.clientIp(req);
    const auth = authenticate(req);

    if (!auth.ok) {
        const gate = limits.hit('credential', ip);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(gate.retryAfterSeconds));
            res.status(429).json({
                error: 'too_many_attempts',
                message: `Çok fazla başarısız kimlik denemesi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`
            });
            return null;
        }
        // Without this header a client has no way to discover that OAuth is
        // an option here: it sees a bare 401 and gives up. With it, Claude Code
        // and friends follow the pointer, register themselves and start the
        // pairing flow on their own.
        setChallengeHeader(req, res);
        res.status(401).json({
            error: 'unauthorized',
            message: "Geçerli bir istemci kimliği gerekli. İki yol var: (1) MCP istemciniz OAuth destekliyorsa bağlantıyı başlatın, tarayıcıda açılan sayfaya telefondaki bağlantı kodunu yazın; (2) ya da Android uygulamasında Ayarlar → MCP → 'AI istemcisi ekle' ile bir anahtar üretip 'Authorization: Bearer <clientId>.<secret>' başlığını elle ekleyin."
        });
        return null;
    }

    if (auth.account && auth.account.status !== 'active') {
        res.status(403).json({
            error: 'account_suspended',
            message: 'Bu istemcinin bağlı olduğu hesap askıya alınmış. Panelden durumu kontrol edin.'
        });
        return null;
    }

    limits.reset('credential', ip);
    return auth;
}

/**
 * Daily command quota, counted per account.
 *
 * Deliberately generous on the free plan: the work runs on the user's own
 * phone, so a command costs the relay a few hundred bytes of routing. This is
 * an abuse ceiling, not a packaging lever — the things worth charging for are
 * the ones that actually cost something.
 *
 * An unclaimed device has no account and therefore no counter. That is the
 * migration path, not a loophole: routing still needs a client secret only the
 * real phone could have minted.
 *
 * `refuse` is passed in rather than a response object because the two callers
 * speak different protocols — one answers in JSON-RPC over SSE, the other in
 * plain HTTP — and the quota rule itself should not have to know which.
 */
async function enforceQuota(auth, refuse) {
    const accountId = auth.record && auth.record.accountId;
    if (!accountId) return true;

    const plan = limits.planFor(auth.account);
    const window = limits.currentUsageWindow();

    let usage;
    try {
        usage = await store.addUsage(accountId, window, 1, 0);
    } catch (e) {
        // A counter that cannot be written must not become a way to block
        // someone's browser. Log it and let the command through.
        console.warn('[Quota] Sayaç yazılamadı:', e.message);
        return true;
    }

    if (usage.commandCount > plan.commandsPerDay) {
        const resetsIn = Math.ceil((window + 86400000 - Date.now()) / 60000);
        refuse(`quota_exceeded: günlük komut kotanız doldu (${plan.commandsPerDay}). Kota ${resetsIn} dakika içinde sıfırlanır. Bu geçici bir sınırdır ve tekrar denemek işe yaramaz — kullanıcıya durumu bildirin.`);
        return false;
    }
    return true;
}

function boundDeviceIds(record) {
    const ids = Array.isArray(record && record.deviceIds) ? [...record.deviceIds] : [];
    return [...new Set(ids.filter(Boolean))];
}

function onlineBrowser(deviceId) {
    const ws = browsers.get(deviceId);
    if (ws && ws.readyState === 1) return ws;
    if (ws) browsers.delete(deviceId);
    return null;
}

function deviceChoiceLabel(deviceId) {
    const record = devices.get(deviceId);
    return record && record.name && record.name !== deviceId
        ? `${record.name} (${deviceId})`
        : deviceId;
}

/**
 * Chooses only among bindings announced by real phones. `deviceId` selects a
 * route; it never grants access, and the destination phone still verifies the
 * client secret before touching its WebView.
 */
function selectBoundDevice(record, requestedDeviceId = null) {
    const allowed = boundDeviceIds(record);
    if (allowed.length === 0) {
        throw new Error('Bu AI bağlantısına bağlı cihaz yok. Android uygulamasında bağlantıyı bir cihaza ekleyin.');
    }

    if (requestedDeviceId) {
        if (!allowed.includes(requestedDeviceId)) {
            throw new Error(`Cihaz '${requestedDeviceId}' bu AI bağlantısı için yetkili değil. Kullanılabilir cihazlar: ${allowed.map(deviceChoiceLabel).join(', ')}.`);
        }
        if (!onlineBrowser(requestedDeviceId)) {
            throw new Error(`Seçilen cihaz (${deviceChoiceLabel(requestedDeviceId)}) çevrimdışı. Android uygulamasını açıp köprü bağlantısını etkinleştirin; tekrar denemek tek başına yardımcı olmaz.`);
        }
        return requestedDeviceId;
    }

    // Routing preference is account-level and deliberately separate from
    // clients.deviceId. The latter identifies the credential origin and
    // changing it merely to route a command would weaken ownership checks.
    const accountDefaultDeviceId = record.accountId
        ? accountCache.get(record.accountId)?.defaultDeviceId
        : null;
    if (accountDefaultDeviceId) {
        if (!allowed.includes(accountDefaultDeviceId)) {
            throw new Error(
                `Ana cihaz (${deviceChoiceLabel(accountDefaultDeviceId)}) bu AI oturumuna bağlı değil. ` +
                'Android uygulamasında oturum senkronizasyonunu açın veya bu oturumun bulunduğu telefonu ana cihaz yapın.'
            );
        }
        if (!onlineBrowser(accountDefaultDeviceId)) {
            throw new Error(
                `Ana cihaz (${deviceChoiceLabel(accountDefaultDeviceId)}) çevrimdışı. ` +
                'Android uygulamasında çevrimiçi bir telefonu “Ana cihaz” olarak seçin.'
            );
        }
        return accountDefaultDeviceId;
    }

    // Accounts created before the explicit setting keep their original route
    // until the owner chooses a default in the Android app.
    if (record.deviceId && allowed.includes(record.deviceId) && onlineBrowser(record.deviceId)) {
        return record.deviceId;
    }

    const online = allowed.filter((id) => !!onlineBrowser(id));
    if (allowed.length === 1 || online.length === 0) {
        throw new Error(`Eşleştirilmiş cihaz (${allowed.map(deviceChoiceLabel).join(', ')}) şu anda çevrimdışı. Android uygulamasının açık ve köprüye bağlı olduğundan emin olun.`);
    }

    // Never silently fail over to another phone. Routing is allowed to choose
    // where a command goes, but that choice must remain visible to the owner.
    throw new Error(`Varsayılan cihaz çevrimdışı. Çevrimiçi yetkili cihazlardan birini deviceId ile seçin: ${online.map(deviceChoiceLabel).join(', ')}.`);
}

function routeCommandToBrowser(type, args, clientId, clientSecret, requestedDeviceId = null) {
    return new Promise((resolve, reject) => {
        const record = clients.get(clientId);
        if (!record) return reject(new Error('İstemci kaydı bulunamadı. Lütfen cihazdan yeniden eşleştirin.'));

        let deviceId;
        try {
            deviceId = selectBoundDevice(record, requestedDeviceId);
        } catch (e) {
            return reject(e);
        }
        const ws = onlineBrowser(deviceId);
        if (!ws) return reject(new Error(`Seçilen cihaz (${deviceChoiceLabel(deviceId)}) bağlantı kurulmadan hemen önce çevrimdışı oldu.`));

        const messageId = randomUUID();
        const payload = JSON.stringify({
            type,
            messageId,
            clientId,
            clientSecret,
            ...args
        });

        const timeout = setTimeout(() => {
            pendingRequests.delete(messageId);
            reject(new Error(`Cihazdan (${deviceId}) yanıt alınamadı, zaman aşımı (30s).`));
        }, 30000);

        pendingRequests.set(messageId, {
            deviceId,
            resolve: (val) => {
                if (val && typeof val === 'object' && !Array.isArray(val)) val.deviceId = deviceId;
                resolve(val);
            },
            reject,
            timeout
        });
        ws.send(payload);
        console.log(`[Bridge] '${type}' → client=${clientId} device=${deviceId} msg=${messageId}`);
    });
}

// Only the Android app is supposed to open this socket. A browser always sends
// an Origin header, so rejecting unknown origins closes cross-site WebSocket
// hijacking without getting in the native client's way.
server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`[WS] Rejected upgrade from disallowed origin: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }
    const ip = limits.clientIp(request);
    const attempt = limits.hit('websocket', ip);
    const openForIp = unauthenticatedWebSocketsByIp.get(ip) || 0;
    if (!attempt.allowed || unauthenticatedWebSockets >= MAX_UNAUTH_WS_GLOBAL || openForIp >= MAX_UNAUTH_WS_PER_IP) {
        const retryAfter = attempt.retryAfterSeconds || 10;
        socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retryAfter}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});


// WebSocket Server Handler (for the Android app)
wss.on('connection', (ws, request) => {
    let deviceId = null;      // set only after a verified register
    let authenticated = false;
    const connectionIp = limits.clientIp(request);
    let holdsUnauthenticatedSlot = true;
    unauthenticatedWebSockets++;
    unauthenticatedWebSocketsByIp.set(
        connectionIp,
        (unauthenticatedWebSocketsByIp.get(connectionIp) || 0) + 1
    );
    const releaseUnauthenticatedSlot = () => {
        if (!holdsUnauthenticatedSlot) return;
        holdsUnauthenticatedSlot = false;
        unauthenticatedWebSockets = Math.max(0, unauthenticatedWebSockets - 1);
        const remaining = Math.max(0, (unauthenticatedWebSocketsByIp.get(connectionIp) || 1) - 1);
        if (remaining === 0) unauthenticatedWebSocketsByIp.delete(connectionIp);
        else unauthenticatedWebSocketsByIp.set(connectionIp, remaining);
    };

    // Drop sockets that never identify themselves.
    const authDeadline = setTimeout(() => {
        if (!authenticated) {
            try { ws.close(4401, 'Kimlik doğrulanmadı'); } catch (e) {}
        }
    }, 10000);

    const fail = (reason) => {
        try { ws.send(JSON.stringify({ type: 'register_nack', reason })); } catch (e) {}
        try { ws.close(4401, reason); } catch (e) {}
    };

    // Registration and client bookkeeping write through to the store, so this
    // handler is async. `ws` does not wait for the returned promise, which means
    // a second frame can start while the first is still awaiting. That is safe
    // here only because `authenticated` is the gate: everything except
    // `register` returns early until it is set, so an early frame is dropped
    // rather than processed against a half-built identity. Keep that property
    // if you add a message type.
    ws.on('message', async (message) => {
        let payload;
        try {
            payload = JSON.parse(message.toString());
        } catch (err) {
            return; // malformed frames are ignored, never logged verbatim
        }

        // --- registration is the only thing an unauthenticated socket may do ---
        if (payload.type === 'register') {
            const id = String(payload.deviceId || '').trim();
            const secret = String(payload.deviceSecret || '');
            if (!id || !secret || secret.length < 16) {
                return fail('deviceId ve en az 16 karakterlik deviceSecret gerekli');
            }

            const known = devices.get(id);
            if (known) {
                if (!safeEquals(sha256(secret), known.secretHash)) {
                    console.warn(`[WS] Rejected register for '${id}': device secret mismatch.`);
                    addLog(null, 'Bilinmeyen', id, 'Reddedilen Kayıt', 'error', 'Cihaz sırrı eşleşmedi.');
                    return fail('Cihaz sırrı eşleşmiyor');
                }
                await store.upsertDevice({
                    id,
                    secretHash: known.secretHash,
                    name: String(payload.deviceName || known.name || id).substring(0, 60)
                });
            } else {
                // Trust on first use used to be the whole enrolment story, and it
                // was only survivable because the registry was one operator's
                // own phone: lose the state file and every deviceId was up for
                // grabs again — including the chance to wipe a real device's
                // client list by registering an empty one.
                //
                // The durable store closes that window, and a claim code puts
                // the device under an account. An unclaimed device still routes
                // commands, because routing needs a client secret only the real
                // phone can mint, and refusing would break every install that
                // upgrades into this version. What it does not get is a place
                // in anyone's panel until its owner claims it.
                await store.upsertDevice({
                    id,
                    accountId: null,
                    secretHash: sha256(secret),
                    name: String(payload.deviceName || id).substring(0, 60),
                    enrolledAt: Date.now()
                });
                console.log(`[WS] New device enrolled (unclaimed): ${id}`);
                addLog(null, 'Android Uygulaması', id, 'Cihaz Kaydoldu', 'info', 'Sahipsiz — panelden bir hesaba bağlanmayı bekliyor.');
            }

            deviceId = id;
            authenticated = true;
            clearTimeout(authDeadline);
            releaseUnauthenticatedSlot();
            limits.reset('websocket', connectionIp);

            // The device is the authority on which clients exist. Rebuild its
            // slice of the registry from what it just told us.
            if (Array.isArray(payload.clients)) {
                const list = [];
                payload.clients.forEach((c) => {
                    const cid = String(c.clientId || '').trim();
                    const hash = String(c.secretHash || '').trim();
                    if (cid && /^[a-f0-9]{64}$/i.test(hash)) {
                        list.push({ id: cid, secretHash: hash, name: String(c.name || 'AI istemcisi').substring(0, 60) });
                    }
                });
                const reconciliation = await store.replaceDeviceClients(id, list);
                await store.publishDeviceClients((await store.getDevice(id))?.accountId, id);
                if (reconciliation && reconciliation.conflicts && reconciliation.conflicts.length > 0) {
                    console.warn(`[WS] Device '${id}' could not bind conflicting clients: ${reconciliation.conflicts.join(', ')}`);
                }
            }
            await store.touchDevice(id, Date.now());
            await refreshRegistryCache();

            const existing = browsers.get(id);
            if (existing && existing !== ws) {
                try { existing.close(1000, 'Yeni bağlantı ile değiştirildi'); } catch (e) {}
            }
            browsers.set(id, ws);

            const record = devices.get(id);
            const mine = [...clients.values()].filter((c) => boundDeviceIds(c).includes(id)).length;
            addLog(null, 'Android Uygulaması', id, 'Cihaz Bağlandı', 'success', `${mine} eşleştirilmiş istemci bildirildi.`);
            ws.send(JSON.stringify({
                type: 'register_ack',
                deviceId: id,
                status: 'success',
                claimed: !!(record && record.accountId),
                catalog: await activeQuickLinkCatalogue()
            }));
            return;
        }

        if (!authenticated) return;

        if (payload.type === 'ping') {
            // Note: no re-binding by deviceId here. The socket identity was
            // fixed at register time and cannot be reassigned by a message.
            ws.send(JSON.stringify({ type: 'pong', deviceId, timestamp: Date.now() }));
            return;
        }

        // Count only a shortcut the authenticated phone says it actually
        // accepted and opened. The event contains the stable catalogue id —
        // never the destination URL or its affiliate query parameters.
        if (payload.type === 'shortcut_opened') {
            const shortcutId = String(payload.shortcutId || '').trim();
            if (/^[a-zA-Z0-9_-]{1,80}$/.test(shortcutId)) {
                await store.recordQuickLinkOpen(shortcutId, Date.now());
            }
            return;
        }

        // The device minted a credential locally and is telling us the hash so
        // it works immediately, without waiting for the next register.
        if (payload.type === 'client_added') {
            const cid = String(payload.clientId || '').trim();
            const hash = String(payload.secretHash || '').trim();
            if (!cid || !/^[a-f0-9]{64}$/i.test(hash)) return;
            const stored = await store.upsertClient({
                id: cid,
                deviceId,
                secretHash: hash,
                name: String(payload.name || 'AI istemcisi').substring(0, 60)
            });
            if (!stored) {
                addLog(cid, payload.name, deviceId, 'İstemci Bağı Reddedildi', 'error', 'Kimlik başka hesaba ait veya anahtar özeti eşleşmiyor.');
                try {
                    ws.send(JSON.stringify({
                        type: 'client_sync_rejected',
                        clientId: cid,
                        reason: 'Bu AI bağlantısı başka bir hesaba ait veya anahtarı eşleşmiyor.'
                    }));
                } catch (e) {}
                return;
            }
            await refreshRegistryCache();
            await store.publishDeviceClients(stored.accountId, deviceId);
            addLog(cid, payload.name, deviceId, 'İstemci Eklendi', 'success', 'Cihaz yeni bir erişim anahtarı üretti.');
            return;
        }

        if (payload.type === 'revoke_client') {
            const cid = String(payload.clientId || '').trim();
            const rec = clients.get(cid);
            if (rec && boundDeviceIds(rec).includes(deviceId)) {
                const owner = rec.accountId && await store.getAccountById(rec.accountId);
                const source = await store.getDevice(deviceId);
                if (owner && (owner.defaultDeviceId !== deviceId || !source?.syncEnabled || !owner.mainReady)) {
                    await store.unbindClient(cid, deviceId);
                    await refreshRegistryCache();
                    return;
                }
                await store.deleteClient(cid);
                await refreshRegistryCache();
                boundDeviceIds(rec).forEach((id) => {
                    const socket = browsers.get(id);
                    if (socket && socket.readyState === 1 && socket !== ws) {
                        try { socket.send(JSON.stringify({ type: 'client_revoked', clientId: cid })); } catch (e) {}
                    }
                });
                addLog(cid, rec.name, deviceId, 'İstemci İptal Edildi', 'info', 'Kullanıcı erişimi kaldırdı.');
            }
            return;
        }

        // The phone asks for a claim code so its owner can attach it to an
        // account. This is the only thing an unclaimed device may do.
        /*
         * The phone offers a pairing code for one of its own clients.
         *
         * This is the only moment a plaintext client secret is held anywhere on
         * the relay, and it is held in memory, for five minutes, for one use.
         * The alternative — storing it so OAuth could hand it out later — would
         * turn a dump of the relay's database into a pile of working browser
         * credentials, which is exactly what this project has always refused.
         *
         * The code is generated *here* rather than on the phone so that two
         * devices cannot mint the same one, and so the relay owns the clock.
         */
        if (payload.type === 'oauth_pairing_request') {
            const cid = String(payload.clientId || '').trim();
            const secret = String(payload.clientSecret || '');
            const locale = payload.locale == null ? null : oauth.normaliseLanguage(payload.locale);
            const record = clients.get(cid);

            // Verified against the registry, not taken on trust: a device may
            // only offer codes for clients that are its own, and only with the
            // secret that matches the hash it announced.
            if (!record || !boundDeviceIds(record).includes(deviceId) || !safeEquals(sha256(secret), record.secretHash)) {
                ws.send(JSON.stringify({
                    type: 'oauth_pairing_code',
                    status: 'rejected',
                    clientId: cid,
                    reason: locale === 'en'
                        ? 'This client does not belong to this device or the key does not match.'
                        : 'Bu istemci bu cihaza ait değil ya da anahtar eşleşmiyor.'
                }));
                return;
            }

            const gate = limits.hit('pairing', deviceId);
            if (!gate.allowed) {
                ws.send(JSON.stringify({
                    type: 'oauth_pairing_code',
                    status: 'rate_limited',
                    clientId: cid,
                    retryAfterSeconds: gate.retryAfterSeconds
                }));
                return;
            }

            // One outstanding code per client: a second request replaces the
            // first rather than leaving two doors open.
            oauthPairings.dropWhere((p) => p.clientId === cid);

            const code = oauth.newPairingCode();
            const entry = oauthPairings.put(code, {
                clientId: cid,
                secret,
                deviceId,
                accountId: record.accountId || null,
                clientName: record.name || 'AI istemcisi',
                locale
            });

            addLog(cid, record.name, deviceId, 'OAuth Kodu', 'info', 'Cihaz bir bağlantı kodu üretti.');
            ws.send(JSON.stringify({
                type: 'oauth_pairing_code',
                status: 'ok',
                clientId: cid,
                code,
                display: oauth.formatPairingCode(code),
                expiresAt: entry.expiresAt
            }));
            return;
        }

        if (payload.type === 'request_claim_code') {
            const device = devices.get(deviceId);
            if (device && device.accountId) {
                ws.send(JSON.stringify({ type: 'claim_code', status: 'already_claimed' }));
                return;
            }
            const gate = limits.hit('claim', deviceId);
            if (!gate.allowed) {
                ws.send(JSON.stringify({
                    type: 'claim_code',
                    status: 'rate_limited',
                    retryAfterSeconds: gate.retryAfterSeconds
                }));
                return;
            }
            const claim = await issueClaimCode(deviceId);
            addLog(null, 'Android Uygulaması', deviceId, 'Bağlama Kodu', 'info', 'Cihaz hesaba bağlanmak için kod istedi.');
            ws.send(JSON.stringify({
                type: 'claim_code',
                status: 'ok',
                code: claim.code,
                expiresAt: claim.expiresAt
            }));
            return;
        }

        if (payload.type === 'response') {
            const pending = pendingRequests.get(payload.messageId);
            // A device may only answer requests that were routed to it.
            if (!pending || pending.deviceId !== deviceId) return;
            clearTimeout(pending.timeout);
            pendingRequests.delete(payload.messageId);
            if (payload.status === 'success' || payload.success === true) {
                pending.resolve(payload.data || {});
            } else {
                pending.reject(new Error(payload.error || 'Cihaz işlem hatası'));
            }
            return;
        }
    });

    ws.on('close', () => {
        clearTimeout(authDeadline);
        releaseUnauthenticatedSlot();
        if (deviceId && browsers.get(deviceId) === ws) {
            browsers.delete(deviceId);
            // An outstanding pairing code holds a plaintext secret and only
            // makes sense while the phone that offered it is reachable. Dropping
            // it here keeps that window as short as the session itself.
            dropPairingsForDevice(deviceId);
            addLog(null, 'Android Uygulaması', deviceId, 'Cihaz Ayrıldı', 'info', 'Bağlantı kapandı.');
        }
    });

    ws.on('error', () => { /* transport errors are handled by close */ });
});

// Keepalive so proxies do not drop idle tunnels.
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === 1) {
            try { ws.ping(); } catch (e) {}
        }
    });
}, 15000);

// ----------------------------------------------------
// 1. STANDARD MCP SSE TRANSPORT ENDPOINTS
// ----------------------------------------------------
const sseSessions = new Map(); // sessionId -> { res, clientInfo }

// Helper to send JSON-RPC response or notification to the MCP client over the active SSE stream
function sendSseJsonRpc(sessionId, jsonRpcMessage) {
    const session = sseSessions.get(sessionId);
    const res = session ? session.res : null;
    if (res) {
        const encoded = JSON.stringify(jsonRpcMessage);
        const outcome = jsonRpcMessage && jsonRpcMessage.error ? 'error' : 'response';
        console.log(`[SSE] JSON-RPC ${outcome} sent (${Buffer.byteLength(encoded, 'utf8')} bytes)`);
        res.write(`event: message\ndata: ${encoded}\n\n`);
        return true;
    } else {
        console.error(`[SSE] Error: Active session not found for ${sessionId}`);
        return false;
    }
}

app.get('/sse', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const plan = limits.planFor(auth.account);
    const openForClient = [...sseSessions.values()].filter((sess) => sess.clientId === auth.clientId).length;
    if (openForClient >= plan.maxSseChannelsPerClient || sseSessions.size >= MAX_SSE_CHANNELS_GLOBAL) {
        res.setHeader('Retry-After', '10');
        return res.status(429).json({
            error: 'too_many_channels',
            message: openForClient >= plan.maxSseChannelsPerClient
                ? `Bu anahtar için aynı anda en fazla ${plan.maxSseChannelsPerClient} kanal açılabilir. Kullanılmayan MCP istemcilerini kapatın.`
                : 'Sunucu eşzamanlı bağlantı sınırına ulaştı. Kısa süre sonra tekrar deneyin.'
        });
    }

    // The session id is random, not derived from the credential. Knowing a
    // session id must never be enough to speak on that session's behalf.
    const sessionId = randomUUID();

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n');

    const heartbeatInterval = setInterval(() => {
        res.write(':\n\n');
    }, 15000);

    sseSessions.set(sessionId, {
        res,
        clientId: auth.clientId,
        deviceId: auth.record.deviceId,
        accountId: auth.record.accountId || null,
        clientName: auth.record.name,
        clientInfo: { name: auth.record.name },
        openedAt: Date.now()
    });
    console.log(`[MCP] SSE session opened for client ${auth.clientId}`);
    addLog(auth.clientId, auth.record.name, auth.record.deviceId, 'SSE Bağlantısı', 'info', 'İstemci kanalı açtı.');

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['host'] || 'localhost:10000';
    res.write(`event: endpoint\ndata: ${protocol}://${host}/message?sessionId=${sessionId}\n\n`);

    req.on('close', () => {
        clearInterval(heartbeatInterval);
        const session = sseSessions.get(sessionId);
        sseSessions.delete(sessionId);
        addLog(auth.clientId, session ? session.clientName : 'N/A', null, 'Bağlantı Kesildi', 'info', 'SSE kanalı kapandı.');
    });
});

// Post endpoint for standard MCP client
/**
 * One JSON-RPC brain, two transports.
 *
 * This used to live inside the `/message` handler, which tied every answer to
 * an open SSE channel. That was fine while HTTP+SSE was the only transport MCP
 * had — but it is the *legacy* one now, and a client that speaks Streamable
 * HTTP simply POSTs and waits for the reply in the same response. Such a client
 * could not talk to this relay at all: there was no endpoint to POST to, so it
 * failed at "cannot connect" long before OAuth was ever reached.
 *
 * So the dispatch takes a `send` and does not know or care where the payload
 * goes. [ctx] carries the two things that differ between the transports: the
 * name to write in the audit log, and somewhere to record what the client
 * called itself (the SSE session has a place for it; a stateless POST does
 * not).
 *
 * Returns 'notification' when the message needed no answer, so the transport
 * can choose the right empty status.
 */
async function dispatchJsonRpc(auth, ctx, rpcRequest, send) {
    console.log(`[MCP] JSON-RPC from client=${auth.clientId} method=${rpcRequest && rpcRequest.method}`);

    if (!rpcRequest || typeof rpcRequest !== 'object') {
        send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return 'handled';
    }

    const { method, params, id } = rpcRequest;

    // Handle notifications (no response required in JSON-RPC, return 202 immediately)
    if (id === undefined || id === null) {
        if (method === 'notifications/initialized') {
            addLog(auth.clientId, ctx.clientName, auth.record.deviceId, 'Sistem Hazır', 'success', 'MCP el sıkışması tamamlandı.');
        }
        return 'notification';
    }

    // Helper to send JSON-RPC formatted responses
    const reply = (result, error = null) => {
        const payload = { jsonrpc: "2.0", id };
        if (error) payload.error = error;
        else payload.result = result;
        send(payload);
    };

    // 1. Handle initialize handshake (CRITICAL for clients like Cursor / Claude Desktop)
    if (method === 'initialize') {
        const clientInfo = params?.clientInfo || {};
        // The reported name is cosmetic only — identity comes from the
        // credential, never from anything the client sends here.
        ctx.setClientInfo(clientInfo);
        addLog(auth.clientId, ctx.clientName, auth.record.deviceId, 'Başlatma', 'success', `Bildirilen istemci: ${String(clientInfo.name || 'bilinmiyor').substring(0, 40)}`);

        reply({
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: {
                tools: {} // We support tools
            },
            serverInfo: {
                name: "mcp-android-bridge",
                version: "1.2.0",
                description: "Android Real Browser MCP Bridge. To view full guide, parameters, and recommended agent workflows, call 'browser_get_tool_documentation'."
            }
        });
        return 'handled';
    }

    // 2. Handle ping
    if (method === 'ping') {
        reply({});
        return 'handled';
    }

    // 3. Handle tools list
    if (method === 'tools/list') {
        reply({ tools: TOOLS });
        return 'handled';
    }

    // 4. Handle tools execution
    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        // `deviceId` chooses among bindings already announced by phones. It is
        // routing metadata only and is never forwarded as an authority signal.
        const requestedDeviceId = String(args.deviceId || '').trim() || null;
        const cleanArgs = { ...args };
        delete cleanArgs.deviceId;

        // Direct handling for Documentation / Skill Guide Tool (Zero-latency server response)
        if (toolName === "browser_get_tool_documentation" || toolName === "get_tool_documentation" || toolName === "browser_get_skills" || toolName === "get_skills") {
            const toolDocResponse = generateDocumentationResponse(cleanArgs.tool_name || cleanArgs.name, cleanArgs.category);
            addLog(auth.clientId, ctx.clientName, 'köprü', `Dokümantasyon: ${toolName}`, 'success', String(cleanArgs.tool_name || 'all'));

            const content = [
                {
                    type: "text",
                    text: JSON.stringify(toolDocResponse, null, 2)
                }
            ];
            reply({ content });
            return 'handled';
        }

        if (toolName === "browser_list_devices") {
            const deviceList = boundDeviceIds(auth.record).map((deviceId) => {
                const device = devices.get(deviceId);
                return {
                    deviceId,
                    name: device?.name || deviceId,
                    online: !!onlineBrowser(deviceId),
                    isDefault: deviceId === (accountCache.get(auth.record.accountId)?.defaultDeviceId || auth.record.deviceId),
                    lastSeenAt: device?.lastSeenAt || null
                };
            });
            addLog(auth.clientId, ctx.clientName, 'köprü', 'Cihazlar Listelendi', 'success', `${deviceList.length} yetkili cihaz`);
            reply({
                content: [{
                    type: "text",
                    text: JSON.stringify({ devices: deviceList }, null, 2)
                }]
            });
            return 'handled';
        }

        let actionType = "";
        switch (toolName) {
            case "browser_navigate": actionType = "navigate"; break;
            case "browser_reload": actionType = "reload"; break;
            case "browser_search": actionType = "search"; break;
            case "browser_get_html": actionType = "get_html"; break;
            // One markdown tool. The old names still dispatch so a client
            // configured before the rename keeps working.
            case "browser_get_local_markdown":
            case "browser_get_crawl4ai_markdown":
            case "browser_get_markdown": actionType = "get_markdown"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_click_at": actionType = "click_at"; break;
            case "browser_type": actionType = "type"; break;
            case "browser_select_option": actionType = "select_option"; break;
            case "browser_pick_date": actionType = "pick_date"; break;
            case "browser_read_form": actionType = "read_form"; break;
            case "browser_fill_form": actionType = "fill_form"; break;
            case "browser_handle_dialog": actionType = "handle_dialog"; break;
            case "browser_press_key": actionType = "press_key"; break;
            case "browser_wait_for": actionType = "wait_for"; break;
            case "browser_toggle_overlay": actionType = "toggle_overlay"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            case "browser_new_tab": actionType = "new_tab"; break;
            case "browser_close_tab": actionType = "close_tab"; break;
            case "browser_list_tabs": actionType = "list_tabs"; break;
            case "browser_list_shortcuts": actionType = "list_shortcuts"; break;
            case "browser_open_shortcut": actionType = "open_shortcut"; break;
            case "browser_switch_tab": actionType = "switch_tab"; break;
            case "browser_get_session_info": actionType = "get_session_info"; break;
            case "browser_list_sessions": actionType = "list_sessions"; break;
            case "browser_clear_session_data": actionType = "clear_session_data"; break;
            case "browser_screenshot": actionType = "screenshot"; break;
            case "browser_switch_session":
                reply({
                    isError: true,
                    content: [{ type: "text", text: "Oturum değiştirme kaldırıldı. Her istemci kendi izole profiline sabitlenmiştir; profil seçimi yalnızca cihaz sahibinin kararıdır." }]
                });
                return 'handled';
            default:
                reply(null, { code: -32601, message: `Tool not found: ${toolName}` });
                return 'handled';
        }

        const clientName = ctx.clientName || 'AI istemcisi';
        const boundDeviceId = requestedDeviceId || auth.record.deviceId;

        if (!(await enforceQuota(auth, (message) => {
            reply({ isError: true, content: [{ type: 'text', text: message }] });
        }))) {
            addLog(auth.clientId, clientName, boundDeviceId, `Kota aşıldı: ${toolName}`, 'error', 'Günlük komut kotası doldu.');
            return 'handled';
        }

        try {
            addLog(auth.clientId, clientName, boundDeviceId, `Araç: ${toolName}`, 'pending', '');
            const startedAt = Date.now();
            let responseData = await routeCommandToBrowser(
                actionType,
                cleanArgs,
                auth.clientId,
                auth.secret,
                requestedDeviceId
            );
            responseData = finalizeMarkdownResponse(toolName, responseData);
            const actualDeviceId = responseData.deviceId || boundDeviceId;

            // Metadata only: size and host, never the content itself.
            const parts = [`${Date.now() - startedAt} ms`];
            if (typeof responseData.markdown === 'string') parts.push(`${responseData.markdown.length} karakter markdown`);
            if (typeof responseData.html === 'string') parts.push(`${responseData.html.length} karakter html`);
            if (typeof responseData.byte_size === 'number') parts.push(`${Math.round(responseData.byte_size / 1024)} KB görüntü`);
            const host = hostOf(responseData.url);
            if (host) parts.push(host);
            addLog(auth.clientId, clientName, actualDeviceId, `Tamamlandı: ${toolName}`, 'success', parts.join(' · '));

            // An image comes back as an MCP image block, not as base64 buried in
            // a JSON string: the client has to be able to actually look at it.
            // The base64 is stripped from the metadata half so the payload is
            // not carried twice.
            if (typeof responseData.image_base64 === 'string' && responseData.image_base64.length > 0) {
                const { image_base64, ...meta } = responseData;
                reply({
                    content: [
                        { type: "image", data: image_base64, mimeType: responseData.mime_type || "image/jpeg" },
                        { type: "text", text: JSON.stringify(meta, null, 2) }
                    ]
                });
                return 'handled';
            }

            reply({ content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] });
        } catch (error) {
            addLog(auth.clientId, clientName, boundDeviceId, `Hata: ${toolName}`, 'error', error?.name || 'Araç hatası');
            reply({
                isError: true,
                content: [{ type: "text", text: `Hata: ${error.message}` }]
            });
        }
        return 'handled';
    }

    // Default response for other unhandled methods
    reply({});
    return 'handled';
}

/**
 * Legacy transport: HTTP+SSE.
 *
 * The client holds a `GET /sse` channel open and POSTs here; answers go back
 * out over that channel. Kept because clients configured against it still work.
 */
app.post('/message', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const { sessionId } = req.query;
    const session = sessionId ? sseSessions.get(sessionId) : null;
    if (!session) {
        return res.status(404).json({ error: 'unknown_session', message: 'Oturum bulunamadı. SSE kanalını yeniden açın.' });
    }
    // Holding a session id is not enough — the credential must own that session.
    if (session.clientId !== auth.clientId) {
        return res.status(403).json({ error: 'session_mismatch', message: 'Bu oturum başka bir istemciye ait.' });
    }

    const outcome = await dispatchJsonRpc(
        auth,
        {
            clientName: session.clientName || 'AI istemcisi',
            setClientInfo(info) { session.clientInfo = info; }
        },
        req.body,
        (payload) => sendSseJsonRpc(sessionId, payload)
    );

    return res.status(outcome === 'notification' ? 202 : 200).send('accepted');
});

/**
 * Current transport: Streamable HTTP.
 *
 * One endpoint, one POST, one answer in the same response. This is what MCP
 * moved to and what current clients try first; without it they report "cannot
 * connect" and never get as far as the 401 that would have pointed them at
 * OAuth.
 *
 * **Stateless on purpose.** The spec lets a server decline to issue an
 * `Mcp-Session-Id`, and there is nothing here worth a session: identity comes
 * from the credential on every request, and the browser state that matters
 * lives on the phone, keyed by client. Adding a session id would create a
 * second thing to expire, revoke and get wrong, protecting nothing.
 */
app.post('/mcp', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    let answer = null;
    const outcome = await dispatchJsonRpc(
        auth,
        {
            clientName: auth.record.name || 'AI istemcisi',
            // Nothing to remember: the reported name is cosmetic and identity
            // never comes from it.
            setClientInfo() {}
        },
        req.body,
        (payload) => { answer = payload; }
    );

    res.setHeader('Cache-Control', 'no-store');
    if (outcome === 'notification' || !answer) return res.status(202).end();
    return res.status(200).json(answer);
});

/**
 * The spec allows a client to open a stream here for server-initiated
 * messages. This relay never sends one — every answer rides the POST that
 * asked for it — so it says so rather than holding a socket that will never
 * carry anything.
 */
app.get('/mcp', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({
        error: 'stream_not_offered',
        message: 'Bu uç sunucu kaynaklı akış sunmaz; her yanıt kendi POST isteğinde döner.'
    });
});

/** Session teardown. There is no session, so this is an acknowledgement. */
app.delete('/mcp', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    return res.status(200).end();
});

function markMarkdownAsSingleResponse(responseData) {
    const text = typeof responseData.markdown === 'string' ? responseData.markdown : '';
    responseData.markdown_offset = 0;
    responseData.markdown_total_characters = text.length;
    responseData.markdown_returned_characters = text.length;
    responseData.has_more = false;
    responseData.next_offset = null;
    delete responseData.continuation_hint;
}

/**
 * Finishes a Markdown response.
 *
 * There used to be a Crawl4AI round trip here: the relay shipped the rendered
 * DOM of a logged-in page to a third service and swapped in its output. It was
 * removed. The device's own converter is not a generic HTML-to-Markdown pass —
 * it produces an interaction map whose element numbers `browser_click` reuses,
 * and no external converter can preserve that. Sending authenticated page HTML
 * off the device to get a worse representation was a bad trade twice over.
 *
 * What is left is bookkeeping: settle the single markdown field, apply the
 * owner's pagination preference and drop the duplicates.
 */
function finalizeMarkdownResponse(toolName, responseData) {
    if (!responseData) return responseData;

    const markdown = responseData.markdown
        || responseData.turndown_markdown
        || responseData.custom_markdown
        || "";

    const isMarkdownTool = toolName === "browser_get_markdown"
        || toolName === "browser_get_markdown"
        || toolName === "browser_get_crawl4ai_markdown"
        || toolName === "get_markdown"
        || toolName === "get_local_markdown";

    if (isMarkdownTool) {
        responseData.markdown = markdown;
        responseData.engine_used = "Built-in Markdown Engine (on-device)";
        responseData.markdown_status = "SUCCESS (Built-in Markdown Engine)";
        delete responseData.html;
    } else {
        responseData.markdown = markdown;
    }

    // The device already paginated its own payload; this only normalises the
    // bookkeeping fields for callers that read them.
    if (typeof responseData.has_more !== 'boolean') {
        markMarkdownAsSingleResponse(responseData);
    }

    delete responseData.turndown_markdown;
    delete responseData.custom_markdown;
    delete responseData.crawl4ai_markdown;
    delete responseData.fit_markdown;
    delete responseData.raw_markdown;
    delete responseData.raw_html;

    return responseData;
}

// ----------------------------------------------------
// 2. DIRECT REST FALLBACK API ENDPOINTS
// ----------------------------------------------------
const directToolHandler = async (type, req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const args = (req.method === 'POST' ? req.body : req.query) || {};
    const requestedDeviceId = String(args.deviceId || '').trim() || null;
    const cleanArgs = { ...args };
    delete cleanArgs.deviceId;

    const clientName = auth.record.name;
    const deviceId = requestedDeviceId || auth.record.deviceId;

    let quotaMessage = null;
    if (!(await enforceQuota(auth, (message) => { quotaMessage = message; }))) {
        addLog(auth.clientId, clientName, deviceId, `Kota aşıldı: ${type}`, 'error', 'Günlük komut kotası doldu.');
        return res.status(429).json({ error: 'quota_exceeded', message: quotaMessage });
    }

    try {
        addLog(auth.clientId, clientName, deviceId, `REST: ${type}`, 'pending', '');
        let responseData = await routeCommandToBrowser(
            type,
            cleanArgs,
            auth.clientId,
            auth.secret,
            requestedDeviceId
        );
        responseData = finalizeMarkdownResponse(type, responseData);
        addLog(auth.clientId, clientName, responseData.deviceId || deviceId, `REST tamam: ${type}`, 'success', hostOf(responseData.url));
        return res.json({ status: "success", data: responseData });
    } catch (error) {
        addLog(auth.clientId, clientName, deviceId, `REST hata: ${type}`, 'error', error?.name || 'Araç hatası');
        return res.status(502).json({ status: "error", error: error.message });
    }
};

// Map both GET, POST, and PUT to avoid 404s no matter what the client uses!
const fallbackRoutes = [
    { path: '/mcp/tools/browser_navigate', type: 'navigate' },
    { path: '/tools/browser_navigate', type: 'navigate' },

    { path: '/mcp/tools/browser_reload', type: 'reload' },
    { path: '/tools/browser_reload', type: 'reload' },
    
    { path: '/mcp/tools/browser_search', type: 'search' },
    { path: '/tools/browser_search', type: 'search' },
    
    { path: '/mcp/tools/browser_list_shortcuts', type: 'list_shortcuts' },
    { path: '/tools/browser_list_shortcuts', type: 'list_shortcuts' },
    { path: '/mcp/tools/browser_open_shortcut', type: 'open_shortcut' },
    { path: '/tools/browser_open_shortcut', type: 'open_shortcut' },

    { path: '/mcp/tools/browser_get_html', type: 'get_html' },
    { path: '/tools/browser_get_html', type: 'get_html' },
    
    { path: '/mcp/tools/browser_get_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_markdown', type: 'get_markdown' },
    // Retired names, still routed so an older client keeps working.
    { path: '/mcp/tools/browser_get_local_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_local_markdown', type: 'get_markdown' },
    { path: '/mcp/tools/browser_get_crawl4ai_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_crawl4ai_markdown', type: 'get_markdown' },
    
    { path: '/mcp/tools/browser_scroll', type: 'scroll' },
    { path: '/tools/browser_scroll', type: 'scroll' },
    
    { path: '/mcp/tools/browser_click', type: 'click' },
    { path: '/tools/browser_click', type: 'click' },

    { path: '/mcp/tools/browser_click_at', type: 'click_at' },
    { path: '/tools/browser_click_at', type: 'click_at' },
    
    { path: '/mcp/tools/browser_type', type: 'type' },
    { path: '/tools/browser_type', type: 'type' },

    { path: '/mcp/tools/browser_select_option', type: 'select_option' },
    { path: '/tools/browser_select_option', type: 'select_option' },

    { path: '/mcp/tools/browser_pick_date', type: 'pick_date' },
    { path: '/tools/browser_pick_date', type: 'pick_date' },

    { path: '/mcp/tools/browser_read_form', type: 'read_form' },
    { path: '/tools/browser_read_form', type: 'read_form' },

    { path: '/mcp/tools/browser_fill_form', type: 'fill_form' },
    { path: '/tools/browser_fill_form', type: 'fill_form' },

    { path: '/mcp/tools/browser_handle_dialog', type: 'handle_dialog' },
    { path: '/tools/browser_handle_dialog', type: 'handle_dialog' },

    { path: '/mcp/tools/browser_press_key', type: 'press_key' },
    { path: '/tools/browser_press_key', type: 'press_key' },

    { path: '/mcp/tools/browser_wait_for', type: 'wait_for' },
    { path: '/tools/browser_wait_for', type: 'wait_for' },

    { path: '/mcp/tools/browser_toggle_overlay', type: 'toggle_overlay' },
    { path: '/tools/browser_toggle_overlay', type: 'toggle_overlay' },
    
    { path: '/mcp/tools/browser_execute_js', type: 'execute_js' },
    { path: '/tools/browser_execute_js', type: 'execute_js' }
];

fallbackRoutes.forEach(route => {
    app.all(route.path, (req, res) => {
        directToolHandler(route.type, req, res);
    });
});

// ----------------------------------------------------
// OAUTH 2.1
//
// What this does and does not do is worth stating once, because the shape is
// unusual: **the token this server issues is the client credential the phone
// already minted.** OAuth here is discovery and delivery, not a new trust
// boundary. `authenticate()` is untouched — an OAuth-issued token and a
// hand-pasted key are the same bytes.
//
// The plaintext secret exists on the relay only between the moment the phone
// offers a pairing code and the moment the token endpoint answers, and only in
// memory. Nothing new is written down. See lib/oauth.js.
// ----------------------------------------------------

/** code -> { clientId, secret, deviceId, accountId, clientName } */
const oauthPairings = oauth.createEphemeralStore(oauth.PAIRING_TTL_MS);

/** code -> { oauthClientId, redirectUri, codeChallenge, clientId, secret, resource } */
const oauthAuthCodes = oauth.createEphemeralStore(oauth.AUTH_CODE_TTL_MS, 15 * 1000);

/**
 * pairing code -> the one callback already created from it.
 *
 * This does not make a phone code authorize twice. It only lets the exact same
 * hosted authorization request repeat its transition while the single-use
 * authorization code is still pending. The token endpoint remains the only
 * place that releases the credential and consumes that code once.
 */
const oauthPendingCallbacks = oauth.createEphemeralStore(oauth.AUTH_CODE_TTL_MS, 15 * 1000);

/**
 * A pairing offer only makes sense while the phone that made it is reachable.
 * Dropping them on disconnect also means a code cannot outlive the session it
 * was created in, which is the shortest honest lifetime for something holding a
 * plaintext secret.
 */
function dropPairingsForDevice(deviceId) {
    return oauthPairings.dropWhere((p) => p.deviceId === deviceId);
}

/**
 * RFC 9728 §5.1 — the pointer a client follows after a 401.
 *
 * Sent on every unauthenticated MCP response, because a client that gets a bare
 * 401 has no way to learn that OAuth is even an option here and will simply
 * fail with "unauthorized".
 */
function setChallengeHeader(req, res) {
    const origin = oauth.originOf(req);
    const suffix = req.path === '/mcp' ? '/mcp' : (req.path === '/sse' ? '/sse' : '');
    res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource${suffix}"`
    );
}

// --- discovery -------------------------------------------------------------
//
// The path-suffixed forms exist because a client whose MCP endpoint is
// `/sse` looks for `/.well-known/oauth-protected-resource/sse` first, per
// RFC 9728 §3.1. Answering both costs one line and saves a failed discovery.

app.get([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/sse',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource/message'
], (req, res) => {
    const origin = oauth.originOf(req);
    const suffix = req.path.endsWith('/mcp') ? '/mcp' :
        (req.path.endsWith('/sse') ? '/sse' : (req.path.endsWith('/message') ? '/message' : ''));
    res.json(oauth.protectedResourceMetadata(origin, suffix));
});

app.get([
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/sse',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/oauth-authorization-server/message'
], (req, res) => {
    res.json(oauth.authorizationServerMetadata(oauth.originOf(req)));
});

// --- dynamic client registration (RFC 7591) --------------------------------

app.post('/oauth/register', async (req, res) => {
    const ip = limits.clientIp(req);
    const gate = limits.hit('register', ip);
    if (!gate.allowed) {
        res.setHeader('Retry-After', String(gate.retryAfterSeconds));
        return res.status(429).json({
            error: 'temporarily_unavailable',
            error_description: `Çok fazla kayıt denemesi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`
        });
    }

    const outcome = oauth.validateRegistration(req.body || {});
    if (outcome.error) {
        return res.status(400).json({ error: outcome.error, error_description: outcome.message });
    }

    try {
        await store.createOAuthClient(outcome.record);
    } catch (e) {
        console.error('[OAuth] Registration could not be stored:', e.message);
        return res.status(500).json({
            error: 'server_error',
            error_description: 'Kayıt saklanamadı.'
        });
    }

    addLog(null, outcome.record.name, null, 'OAuth İstemci Kaydı', 'info', 'Yeni bir MCP istemcisi kendini kaydetti.');
    return res.status(201).json(oauth.registrationResponse(outcome.record));
});

// --- authorization ---------------------------------------------------------

/**
 * Reads and checks everything that must be right before a person is shown
 * anything. Returns either a `redirect` (a protocol error the client should be
 * told about at its own callback) or a `fail` (an error that must be rendered
 * here, because sending it to an unverified address is how open redirectors are
 * built).
 */
async function readAuthorizeRequest(query, issuer) {
    const clientId = String(query.client_id || '');
    const redirectUri = String(query.redirect_uri || '');
    const state = query.state == null ? '' : String(query.state);
    const challenge = String(query.code_challenge || '');
    const method = String(query.code_challenge_method || '');
    const responseType = String(query.response_type || '');
    const resource = query.resource == null ? '' : String(query.resource);

    if (!clientId) return { fail: 'client_id eksik.' };

    let record = null;
    if (clientId.startsWith('https://')) {
        const resolved = await oauth.resolveClientMetadata(clientId);
        if (resolved.error) return { fail: resolved.error };
        record = resolved.record;
    } else try {
        record = await store.getOAuthClient(clientId);
    } catch (e) {
        return { fail: 'İstemci kaydı okunamadı.' };
    }
    if (!record) {
        return { fail: 'Bu client_id kayıtlı değil. İstemcinin yeniden kayıt olması gerekiyor.' };
    }

    if (!redirectUri) return { fail: 'redirect_uri eksik.' };
    const allowed = record.redirectUris.some((uri) => oauth.redirectMatches(uri, redirectUri));
    if (!allowed) {
        // Never redirect to prove a redirect is wrong.
        return { fail: 'redirect_uri bu istemci için kayıtlı adreslerle eşleşmiyor.' };
    }

    // From here on the address is verified, so protocol errors can go home.
    if (responseType !== 'code') {
        return { redirect: { error: 'unsupported_response_type', description: 'Yalnızca response_type=code destekleniyor.' }, redirectUri, state };
    }
    if (!challenge) {
        return { redirect: { error: 'invalid_request', description: 'code_challenge zorunlu: bu sunucu PKCE olmadan yetkilendirme yapmaz.' }, redirectUri, state };
    }
    if (method && method !== 'S256') {
        return { redirect: { error: 'invalid_request', description: 'code_challenge_method yalnızca S256 olabilir.' }, redirectUri, state };
    }

    return { ok: true, record, clientId, redirectUri, state, challenge, resource, issuer };
}

function redirectWithError(res, redirectUri, state, error, description, issuer) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (description) url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    if (issuer) url.searchParams.set('iss', issuer);
    return res.redirect(302, url.toString());
}

function oauthRequestLanguage(req) {
    const explicit = (req.body && req.body.lang) || (req.query && req.query.lang);
    return oauth.normaliseLanguage(
        explicit,
        oauth.languageFromAcceptLanguage(req.get('accept-language'))
    );
}

function authorizeHidden(parsed, language) {
    return {
        client_id: parsed.clientId,
        redirect_uri: parsed.redirectUri,
        state: parsed.state,
        code_challenge: parsed.challenge,
        code_challenge_method: 'S256',
        response_type: 'code',
        resource: parsed.resource,
        lang: oauth.normaliseLanguage(language)
    };
}

function oauthAuthorizeHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function isClaudeCallback(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'claude.ai' || host.endsWith('.claude.ai') ||
            host === 'claude.com' || host.endsWith('.claude.com');
    } catch (e) {
        return false;
    }
}

function isChatGptCallback(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
    } catch (e) {
        return false;
    }
}

function isHostedCallback(value) {
    return isClaudeCallback(value) || isChatGptCallback(value);
}

function samePendingAuthorization(pending, parsed) {
    return pending &&
        pending.oauthClientId === parsed.clientId &&
        pending.redirectUri === parsed.redirectUri &&
        pending.codeChallenge === parsed.challenge &&
        pending.state === parsed.state &&
        pending.resource === parsed.resource;
}

function sendAuthorizationCallback(res, callbackUrl, language = 'tr') {
    const lang = oauth.normaliseLanguage(language);
    const hostedClient = isClaudeCallback(callbackUrl)
        ? (lang === 'en' ? 'Claude' : "Claude'a")
        : (isChatGptCallback(callbackUrl) ? (lang === 'en' ? 'ChatGPT' : "ChatGPT'ye") : '');
    if (!hostedClient) return res.redirect(303, callbackUrl);

    // A fresh document navigation keeps hosted connector callback behaviour
    // out of the form POST. Refresh, meta refresh, top-level JavaScript
    // navigation and a visible link cover the different embedded browsers used
    // by Claude and ChatGPT without changing the OAuth grant itself.
    res.setHeader('Refresh', `0; url=${callbackUrl}`);
    return res.status(200).send(oauth.renderOAuthRedirectPage(callbackUrl, hostedClient, lang));
}

app.get('/oauth/authorize', async (req, res) => {
    oauthAuthorizeHeaders(res);
    const language = oauthRequestLanguage(req);
    const parsed = await readAuthorizeRequest(req.query || {}, oauth.originOf(req));
    if (parsed.fail) {
        return res.status(400).send(oauth.renderAuthorizePage({
            clientName: 'Bilinmeyen istemci',
            hidden: {},
            error: parsed.fail,
            language
        }));
    }
    if (parsed.redirect) {
        return redirectWithError(res, parsed.redirectUri, parsed.state, parsed.redirect.error,
            oauth.localizeOAuthMessage(parsed.redirect.description, language), parsed.issuer);
    }

    return res.send(oauth.renderAuthorizePage({
        clientName: parsed.record.name,
        hidden: authorizeHidden(parsed, language),
        language
    }));
});

app.post('/oauth/authorize', async (req, res) => {
    oauthAuthorizeHeaders(res);
    const language = oauthRequestLanguage(req);
    // Claude's hosted connector browser can submit only the visible code field
    // and omit hidden inputs. The form action carries the same OAuth context in
    // its query string, so merge both sources with the submitted body winning.
    // Every value still goes through readAuthorizeRequest: registered client,
    // exact redirect URI and PKCE are validated exactly as before.
    const submitted = { ...(req.query || {}), ...(req.body || {}) };
    const parsed = await readAuthorizeRequest(submitted, oauth.originOf(req));
    if (parsed.fail) {
        return res.status(400).send(oauth.renderAuthorizePage({
            clientName: 'Bilinmeyen istemci',
            hidden: {},
            error: parsed.fail,
            language
        }));
    }
    if (parsed.redirect) {
        return redirectWithError(res, parsed.redirectUri, parsed.state, parsed.redirect.error,
            oauth.localizeOAuthMessage(parsed.redirect.description, language), parsed.issuer);
    }

    const ip = limits.clientIp(req);
    const gate = limits.hit('pairing', ip);
    if (!gate.allowed) {
        res.setHeader('Retry-After', String(gate.retryAfterSeconds));
        return res.status(429).send(oauth.renderAuthorizePage({
            clientName: parsed.record.name,
            hidden: authorizeHidden(parsed, language),
            error: `Çok fazla hatalı kod denendi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`,
            language
        }));
    }

    const code = oauth.normalisePairingCode((req.body || {}).code);
    if (!oauth.isWellFormedCode(code)) {
        return res.status(400).send(oauth.renderAuthorizePage({
            clientName: parsed.record.name,
            hidden: authorizeHidden(parsed, language),
            error: 'Kod 8 karakter olmalı. Telefondaki kodu olduğu gibi yazın; büyük/küçük harf ve tire fark etmez.',
            language
        }));
    }

    const pending = isHostedCallback(parsed.redirectUri) ? oauthPendingCallbacks.peek(code) : null;
    if (samePendingAuthorization(pending, parsed)) {
        return sendAuthorizationCallback(res, pending.callbackUrl, pending.language || language);
    }

    // Single-use: `take` removes it whether or not the rest succeeds, so a code
    // cannot be tried twice with two different clients.
    const pairing = oauthPairings.take(code);
    if (!pairing) {
        return res.status(400).send(oauth.renderAuthorizePage({
            clientName: parsed.record.name,
            hidden: authorizeHidden(parsed, language),
            error: 'Kod geçersiz ya da süresi dolmuş. Telefondan yeni bir kod alın — kodlar 5 dakika geçerlidir ve bir kez kullanılır.',
            language
        }));
    }

    // The pairing code carries the phone's app-language preference. It is
    // presentation metadata only and never participates in authorization.
    const successLanguage = oauth.normaliseLanguage(pairing.locale, language);

    // The client may have been revoked between the phone offering the code and
    // the user typing it.
    const stillValid = clients.get(pairing.clientId);
    if (!stillValid || !safeEquals(sha256(pairing.secret), stillValid.secretHash)) {
        return res.status(400).send(oauth.renderAuthorizePage({
            clientName: parsed.record.name,
            hidden: authorizeHidden(parsed, successLanguage),
            error: 'Bu kodun bağlı olduğu erişim anahtarı artık geçerli değil. Telefondan yeni bir kod alın.',
            language: successLanguage
        }));
    }

    limits.reset('pairing', ip);

    const authCode = oauth.base64url(randomBytes(32));
    oauthAuthCodes.put(authCode, {
        oauthClientId: parsed.clientId,
        redirectUri: parsed.redirectUri,
        codeChallenge: parsed.challenge,
        clientId: pairing.clientId,
        secret: pairing.secret,
        resource: parsed.resource,
        pairingCode: code
    });

    addLog(
        pairing.clientId,
        pairing.clientName,
        pairing.deviceId,
        'OAuth Yetkilendirme',
        'success',
        `${parsed.record.name} eşleştirme kodunu kullandı.`
    );

    const url = new URL(parsed.redirectUri);
    url.searchParams.set('code', authCode);
    if (parsed.state) url.searchParams.set('state', parsed.state);
    url.searchParams.set('iss', parsed.issuer);
    const callbackUrl = url.toString();
    if (isHostedCallback(parsed.redirectUri)) {
        oauthPendingCallbacks.put(code, {
            oauthClientId: parsed.clientId,
            redirectUri: parsed.redirectUri,
            codeChallenge: parsed.challenge,
            state: parsed.state,
            resource: parsed.resource,
            callbackUrl,
            language: successLanguage
        });
    }
    return sendAuthorizationCallback(res, callbackUrl, successLanguage);
});

// --- token -----------------------------------------------------------------

app.post('/oauth/token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};

    if (String(body.grant_type || '') !== 'authorization_code') {
        return res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: 'Yalnızca authorization_code destekleniyor. Bu röle yenileme jetonu vermez çünkü verdiği erişim jetonu süresizdir; iptal telefondan ya da /oauth/revoke ile yapılır.'
        });
    }

    const grant = oauthAuthCodes.take(String(body.code || ''));
    if (!grant) {
        return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Yetkilendirme kodu geçersiz, kullanılmış ya da süresi dolmuş.'
        });
    }
    if (grant.pairingCode) oauthPendingCallbacks.delete(grant.pairingCode);

    if (String(body.client_id || '') !== grant.oauthClientId) {
        return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Kod başka bir istemci için verilmiş.'
        });
    }

    // Exact match here, not the loopback-tolerant one: at this point the client
    // is echoing back the address it was actually redirected to.
    if (String(body.redirect_uri || '') !== grant.redirectUri) {
        return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'redirect_uri yetkilendirme isteğindekiyle aynı olmalı.'
        });
    }

    if (!oauth.verifyPkce(body.code_verifier, grant.codeChallenge, 'S256')) {
        return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'code_verifier, code_challenge ile eşleşmiyor.'
        });
    }

    const record = clients.get(grant.clientId);
    if (!record || !safeEquals(sha256(grant.secret), record.secretHash)) {
        return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Bu koda bağlı erişim anahtarı artık geçerli değil.'
        });
    }

    try { await store.touchOAuthClient(grant.oauthClientId, Date.now()); } catch (e) { /* not worth failing a login over */ }

    addLog(
        grant.clientId,
        record.name,
        record.deviceId,
        'OAuth Token Teslimi',
        'success',
        'OAuth istemcisi erişim anahtarını PKCE doğrulamasından sonra aldı.'
    );

    // The token *is* the credential. There is nothing else it could be without
    // the relay storing a second secret at rest, which is the thing this design
    // exists to avoid. It does not expire, so no `expires_in` is claimed and no
    // refresh token is issued; a client that wants one told the truth about it
    // is better served by the absence of the field than by a lie.
    return res.json({
        access_token: `${grant.clientId}.${grant.secret}`,
        token_type: 'Bearer'
    });
});

// --- revocation (RFC 7009) -------------------------------------------------

app.post('/oauth/revoke', async (req, res) => {
    // RFC 7009 §2.2: an unknown token is a success. Saying "that token does not
    // exist" would turn this endpoint into an oracle for guessing tokens.
    res.setHeader('Cache-Control', 'no-store');

    const token = String((req.body || {}).token || '');
    const dot = token.indexOf('.');
    if (dot <= 0) return res.status(200).end();

    const clientId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    const record = clients.get(clientId);
    if (!record || !safeEquals(sha256(secret), record.secretHash)) return res.status(200).end();

    try {
        await store.deleteClient(clientId);
        clients.delete(clientId);
    } catch (e) {
        console.error('[OAuth] Revocation failed:', e.message);
        return res.status(200).end();
    }

    // Fail-closed either way, but tell the phone so its client list does not
    // disagree with what the relay will honour.
    boundDeviceIds(record).forEach((deviceId) => {
        const socket = browsers.get(deviceId);
        if (socket && socket.readyState === 1) {
            try { socket.send(JSON.stringify({ type: 'client_revoked', clientId })); } catch (e) {}
        }
        dropPairingsForDevice(deviceId);
    });

    addLog(clientId, record.name, record.deviceId, 'OAuth İptal', 'info', 'İstemci kendi erişimini iptal etti.');
    return res.status(200).end();
});

// REST Documentation / Skills Endpoint
app.all(['/mcp/tools/browser_get_tool_documentation', '/tools/browser_get_tool_documentation', '/api/docs', '/api/skills'], (req, res) => {
    const args = req.method === 'POST' ? req.body : req.query;
    const toolDocResponse = generateDocumentationResponse(args.tool_name || args.name, args.category);
    return res.json(toolDocResponse);
});

// ----------------------------------------------------
// APP API
//
// Everything a normal user does happens in the Android app: signing up, signing
// in, changing a password, reading their own audit trail. Nobody is sent to a
// website. The panel that remains is an operator console for whoever runs the
// relay, not a place users are expected to visit.
//
// These endpoints authenticate with the **device** credential the phone already
// holds — `Authorization: Bearer <deviceId>.<deviceSecret>` — not with an
// account session. That is deliberate:
//
//   * the phone never has to store the account password or a session token,
//     so a stolen backup does not hand over the account;
//   * the device is already proving who it is on the WebSocket, so this reuses
//     a secret that exists rather than inventing a second one;
//   * and binding is implicit — the device that signs in *is* the device that
//     gets bound, which removes the claim-code round trip entirely.
//
// The claim code still exists for the operator console's own use. It is no
// longer on the user's path.
// ----------------------------------------------------

// Account metadata, client hashes and encrypted packages are private even
// though the relay cannot decrypt them. Make the cache policy explicit for
// browsers, proxies and hosting layers.
app.use('/api/v1', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

/** Verifies the phone's own credential. Returns the device record or null. */
function requireDevice(req, res) {
    const ip = limits.clientIp(req);
    const raw = String(req.headers['authorization'] || '');
    const value = raw.toLowerCase().startsWith('bearer ') ? raw.substring(7).trim() : raw.trim();
    const cred = parseCredential(value);

    const refuse = () => {
        const gate = limits.hit('credential', ip);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(gate.retryAfterSeconds));
            res.status(429).json({ error: 'too_many_attempts', message: 'Çok fazla başarısız deneme.' });
            return null;
        }
        res.status(401).json({
            error: 'unauthorized',
            message: 'Cihaz kimliği doğrulanamadı. Uygulama köprüye kayıtlı değil.'
        });
        return null;
    };

    if (!cred) return refuse();
    const device = devices.get(cred.clientId);
    if (!device) return refuse();
    if (!safeEquals(sha256(cred.secret), device.secretHash)) return refuse();

    limits.reset('credential', ip);
    return device;
}

/** The account view the app renders. Never includes a hash or a secret. */
async function accountSnapshot(device) {
    const account = device.accountId ? await store.getAccountById(device.accountId) : null;
    if (!account) {
        return { linked: false, deviceId: device.id, deviceName: device.name };
    }
    const plan = limits.planFor(account);
    const [usage, deviceCount, clientCount] = await Promise.all([
        store.getUsage(account.id, limits.currentUsageWindow()),
        store.countDevices(account.id),
        store.countClients(account.id)
    ]);
    return {
        linked: true,
        accountId: account.id,
        deviceId: device.id,
        deviceName: device.name,
        mainGeneration: account.mainGeneration || 0,
        cookieKeyRevision: account.cookieKeyRevision || 0,
        mainReady: account.mainReady === true,
        defaultDeviceId: account.defaultDeviceId || '',
        isDefaultBrowser: account.defaultDeviceId === device.id,
        sessionSyncEnabled: device.syncEnabled === true,
        cookieSyncEnabled: device.cookieSyncEnabled === true,
        // Backward-compatible alias for app builds before the two switches
        // were separated.
        syncEnabled: device.syncEnabled === true,
        email: account.email,
        status: account.status,
        plan: { id: account.plan, label: plan.label },
        quota: {
            commandsUsed: usage.commandCount,
            commandsPerDay: plan.commandsPerDay,
            maxDevices: plan.maxDevices,
            auditRetentionDays: plan.auditRetentionDays
        },
        counts: { devices: deviceCount, clients: clientCount }
    };
}

/** Attaches this device to an account, and its clients with it. */
async function linkDeviceToAccount(device, account) {
    await store.setDeviceAccount(device.id, account.id);
    // Signing in must never silently promote a backup into the cloud writer.
    await refreshRegistryCache();
    addLog(null, 'Uygulama', device.id, 'Cihaz Bağlandı', 'success', 'Cihaz hesaba bağlandı.');
}

app.post('/api/v1/register', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;

    if (!ALLOW_REGISTRATION) {
        return res.status(403).json({ error: 'registration_closed', message: 'Bu köprü yeni kayıtlara kapalı.' });
    }

    const gate = limits.hit('register', limits.clientIp(req));
    if (!gate.allowed) {
        res.setHeader('Retry-After', String(gate.retryAfterSeconds));
        return res.status(429).json({
            error: 'too_many_attempts',
            message: `Çok fazla kayıt denemesi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`
        });
    }

    const email = accounts.normaliseEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');

    const emailIssue = accounts.emailProblem(email);
    if (emailIssue) return res.status(400).json({ error: 'invalid_email', message: emailIssue });
    const passwordIssue = accounts.passwordProblem(password);
    if (passwordIssue) return res.status(400).json({ error: 'weak_password', message: passwordIssue });

    if (await store.getAccountByEmail(email)) {
        return res.status(409).json({
            error: 'email_taken',
            message: 'Bu e-posta ile hesap oluşturulamadı. Zaten hesabınız varsa giriş yapın.'
        });
    }

    const { passwordHash, passwordSalt } = await accounts.hashPassword(password);
    let account = await store.createAccount({ email, passwordHash, passwordSalt });

    // The operator's own accounts are named in the environment, so the first
    // person to sign up on a fresh relay does not have to be promoted by hand
    // — and nobody else can promote themselves by signing up.
    if (ADMIN_EMAILS.includes(email)) {
        account = await store.setAccountAdmin(account.id, true) || account;
        console.log(`[Auth] Yönetici hesabı: ${email}`);
    }

    await linkDeviceToAccount(device, account);
    console.log(`[Auth] Yeni hesap (uygulamadan): ${account.id}`);
    res.status(201).json(await accountSnapshot(devices.get(device.id)));
});

app.post('/api/v1/login', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;

    const email = accounts.normaliseEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const ip = limits.clientIp(req);

    for (const key of [`e:${email}`, `i:${ip}`]) {
        const gate = limits.hit('login', key);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(gate.retryAfterSeconds));
            return res.status(429).json({
                error: 'too_many_attempts',
                message: `Çok fazla giriş denemesi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`
            });
        }
    }

    const account = await store.getAccountByEmail(email);
    const ok = account && await accounts.verifyPassword(password, account.passwordHash, account.passwordSalt);
    if (!ok) {
        return res.status(401).json({ error: 'bad_credentials', message: 'E-posta veya parola hatalı.' });
    }
    if (account.status !== 'active') {
        return res.status(403).json({ error: 'account_suspended', message: 'Bu hesap askıya alınmış.' });
    }

    limits.reset('login', `e:${email}`);
    limits.reset('login', `i:${ip}`);

    // Signing in on a phone that is already somebody else's is a mistake worth
    // refusing rather than silently resolving in either direction.
    if (device.accountId && device.accountId !== account.id) {
        return res.status(409).json({
            error: 'device_linked_elsewhere',
            message: 'Bu cihaz başka bir hesaba bağlı. Önce mevcut hesaptan çıkış yapın.'
        });
    }

    const plan = limits.planFor(account);
    if (!device.accountId) {
        const owned = await store.countDevices(account.id);
        if (owned >= plan.maxDevices) {
            return res.status(409).json({
                error: 'device_limit',
                message: `${plan.label} planı ${plan.maxDevices} cihazla sınırlı. Başka bir cihazın bağını koparıp tekrar deneyin.`
            });
        }
        await linkDeviceToAccount(device, account);
    }

    res.json(await accountSnapshot(devices.get(device.id)));
});

app.get('/api/v1/account', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    res.json(await accountSnapshot(device));
});

/** Makes the calling phone the explicit no-deviceId route for this account. */
// Selection changes routing and the sole cloud writer together. The target phone
// prepares the cloud baseline before acknowledging readiness; selection never enables sync.
app.post(['/api/v1/account/main-device', '/api/v1/account/default-device'], async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked' });
    const targetId = req.body?.enabled === false ? null : String(req.body?.deviceId || device.id);
    const changed = await store.setAccountDefaultDevice(device.accountId, targetId);
    if (!changed) return res.status(409).json({ error: 'main_device_failed', message: 'Ana cihaz bu hesaba ait olmalı.' });
    await refreshRegistryCache();
    addLog(null, 'Uygulama', device.id, 'Ana Cihaz Seçildi', 'success',
        targetId ? 'Kullanıcı ana cihazı seçti; bulut hazırlığı bekleniyor.' : 'Ana cihaz seçimi kaldırıldı.');
    for (const owned of await store.listDevices(device.accountId)) {
        const socket = browsers.get(owned.id);
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'main_device_changed' }));
    }
    res.json({ status: 'ok', ...(await accountSnapshot(devices.get(device.id))) });
});

app.post('/api/v1/account/main-device/ready', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId || !device.syncEnabled) return res.status(403).json({ error: 'sync_disabled' });
    const ready = await store.markMainReady(device.accountId, device.id, Number(req.body?.generation));
    if (!ready) return res.status(409).json({ error: 'main_device_changed', message: 'Ana cihaz değişti; eşitlemeyi yenileyin.' });
    await store.publishDeviceClients(device.accountId, device.id);
    await refreshRegistryCache();
    res.json({ status: 'ok', ...(await accountSnapshot(devices.get(device.id))) });
});

/**
 * The account-owned inventory used by the Android app's device-sync screen.
 *
 * A client hash is intentionally included: another phone on the same account
 * needs it to verify the existing plaintext credential after the owner opts in
 * to restoring that connection. The hash cannot authenticate an MCP request,
 * and the relay still never stores or returns the plaintext secret.
 */
async function accountSyncSnapshot(device) {
    const [account, ownedDevices, ownedClients, cookieSnapshots, credentialPackages, cookieHandoffs] = await Promise.all([
        store.getAccountById(device.accountId),
        store.listDevices(device.accountId),
        store.listClients(device.accountId),
        store.listCookieSnapshots(device.accountId),
        store.listCredentialPackages(device.accountId, device.id),
        store.listCookieHandoffs(device.accountId, device.id)
    ]);
    const cookiesByClient = new Map(cookieSnapshots.map((row) => [row.clientId, row]));
    const handoffsByClient = new Map(cookieHandoffs.map((row) => [row.clientId, row]));
    // The routing registry exists even for local-only devices. Only the main
    // phone explicitly publishes connections into the cloud restore inventory.
    const syncedClients = ownedClients.filter((row) => row.cloudPublished === true);
    return {
        credentialSharingVersion: 1,
        cookieHandoffVersion: 1,
        credentialPackages,
        mainGeneration: account?.mainGeneration || 0,
        cookieKeyRevision: account?.cookieKeyRevision || 0,
        mainReady: account?.mainReady === true,
        defaultDeviceId: account?.defaultDeviceId || '',
        devices: ownedDevices.map((row) => ({
            deviceId: row.id,
            name: row.name || row.id,
            createdAt: row.createdAt || 0,
            lastSeenAt: row.lastSeenAt || 0,
            online: browsers.has(row.id),
            isCurrent: row.id === device.id,
            isDefault: row.id === account?.defaultDeviceId,
            syncEnabled: row.syncEnabled === true,
            cookieSyncEnabled: row.cookieSyncEnabled === true
        })),
        clients: syncedClients.map((row) => {
            const encrypted = cookiesByClient.get(row.id);
            const handoff = handoffsByClient.get(row.id);
            return {
                clientId: row.id,
                name: row.name || 'AI istemcisi',
                secretHash: row.secretHash,
                createdAt: row.createdAt || 0,
                originDeviceId: row.deviceId,
                // Legacy field name retained for app builds that predate the
                // account-level routing preference.
                defaultDeviceId: row.deviceId,
                deviceIds: Array.isArray(row.deviceIds) ? row.deviceIds : [row.deviceId].filter(Boolean),
                cookieSyncEnabled: !!row.cookieSyncEnabled,
                cookieSnapshot: encrypted ? {
                    version: encrypted.version,
                    iv: encrypted.iv,
                    ciphertext: encrypted.ciphertext,
                    updatedAt: encrypted.updatedAt,
                    lastWriterDeviceId: encrypted.sourceDeviceId || ''
                } : null,
                cookieHandoff: handoff ? {
                    version: handoff.version,
                    iv: handoff.iv,
                    ciphertext: handoff.ciphertext,
                    updatedAt: handoff.updatedAt,
                    lastWriterDeviceId: handoff.sourceDeviceId || ''
                } : null
            };
        })
    };
}

async function notifyAccountSyncChanged(accountId) {
    for (const d of await store.listDevices(accountId)) {
        const ws = browsers.get(d.id);
        if (ws) try { ws.send(JSON.stringify({ type: 'main_device_changed' })); } catch (_) { /* Reconnect refreshes metadata. */ }
    }
}

async function requireAccountSync(req, res) {
    const device = requireDevice(req, res);
    if (!device) return null;
    if (!device.accountId) {
        res.status(403).json({
            error: 'not_linked',
            message: 'Cihazlar arası senkronizasyon için önce hesabınıza giriş yapın.'
        });
        return null;
    }
    return accountSyncSnapshot(device);
}

app.get('/api/v1/sync', async (req, res) => {
    const snapshot = await requireAccountSync(req, res);
    if (snapshot) res.json(snapshot);
});

// Only ciphertext crosses the storage boundary. A device still checks the
// decrypted secret against its local hash before exposing it or offering OAuth.
app.get('/api/v1/sync/clients/:clientId/credential', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked', message: 'Anahtarı almak için hesabınıza giriş yapın.' });
    const packages = await store.listCredentialPackages(device.accountId, device.id);
    const pkg = packages.find(p => p.clientId === req.params.clientId);
    res.set('Cache-Control', 'no-store');
    if (!pkg) return res.status(404).json({ error: 'credential_not_available',
        message: 'Anahtar henüz paylaşılmadı. Oturumu oluşturan telefonda güncel uygulamayı açıp AI oturumu senkronizasyonunu etkinleştirin; ardından tekrar deneyin. Mevcut token değişmez.' });
    res.json({ credentialPackage: pkg });
});

app.put('/api/v1/sync/clients/:clientId/credential', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked' });
    const body = req.body || {};
    const allowed = ['version', 'secretHash', 'iv', 'ciphertext', 'cookieKeyRevision'];
    const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
    if (Object.keys(body).some(k => !allowed.includes(k)) || body.version !== 1 ||
        typeof body.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.secretHash) ||
        typeof body.iv !== 'string' || body.iv.length !== 16 || !base64.test(body.iv) ||
        Buffer.from(body.iv, 'base64').length !== 12 ||
        typeof body.ciphertext !== 'string' || body.ciphertext.length < 24 || body.ciphertext.length > 2048 ||
        !base64.test(body.ciphertext) || Buffer.from(body.ciphertext, 'base64').length < 17 ||
        !Number.isSafeInteger(body.cookieKeyRevision) || body.cookieKeyRevision < 0) {
        return res.status(400).json({ error: 'invalid_credential_package', message: 'Şifreli anahtar paketi geçersiz. Uygulamayı güncelleyin.' });
    }
    const stored = await store.writeCredentialPackage({
        clientId: req.params.clientId, accountId: device.accountId, sourceDeviceId: device.id,
        version: body.version, secretHash: body.secretHash, iv: body.iv, ciphertext: body.ciphertext,
        cookieKeyRevision: body.cookieKeyRevision, updatedAt: Date.now()
    });
    if (!stored) return res.status(409).json({ error: 'credential_share_conflict',
        message: 'Anahtarı yalnızca kaynak cihaz, AI oturumu eşitlemesi açıkken paylaşabilir. Hesap bilgilerini yenileyip tekrar deneyin.' });
    res.json({ status: 'ok' });
});

// The envelope is encrypted on the phone with the password-derived key. Keeping
// the data key stable across password changes preserves existing cookie packages.
app.get('/api/v1/sync/key-envelope', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked' });
    const account = await store.getAccountById(device.accountId);
    let envelope = account.cookieKeyEnvelope || null;
    const supportedVersion = Number.parseInt(req.headers['x-cookie-key-envelope-version'] || '1', 10);
    // Version 2 stores both wrappers. Updated apps use the stronger wrapper;
    // older installed apps receive the legacy wrapper and keep working until
    // they update, without weakening the wrapper selected by new apps.
    if (envelope?.version === 2 && supportedVersion < 2) envelope = envelope.legacy;
    res.json({ envelope, revision: account.cookieKeyRevision || 0 });
});

app.get('/api/v1/sync/cookie-backups', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked' });
    const [snapshots, connections] = await Promise.all([
        store.listCookieSnapshots(device.accountId), store.listClients(device.accountId)
    ]);
    const names = new Map(connections.map(c => [c.id, c.name]));
    res.json({ backups: snapshots.map(s => ({ clientId: s.clientId, name: names.get(s.clientId) || 'AI oturumu',
        updatedAt: s.updatedAt, bytes: Buffer.byteLength(s.ciphertext, 'base64') })) });
});

// Explicit account-owner deletion is available even when all sync is off. It
// never clears local profiles or routing bindings, and invalidates in-flight uploads.
app.delete('/api/v1/sync/cookie-backups', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked' });
    const selected = req.body?.backups;
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 500 ||
        selected.some(s => !s || typeof s.clientId !== 'string' || !Number.isSafeInteger(s.updatedAt) || s.updatedAt < 1) ||
        new Set(selected.map(s => s.clientId)).size !== selected.length) {
        return res.status(400).json({ error: 'invalid_selection', message: 'Silinecek yedekleri listeden seçin.' });
    }
    if (!await store.deleteCookieBackups(device.accountId, selected)) {
        return res.status(409).json({ error: 'backups_changed', message: 'Yedek listesi değişti. Listeyi yenileyip tekrar seçin.' });
    }
    await refreshRegistryCache();
    for (const d of await store.listDevices(device.accountId)) {
        const ws = browsers.get(d.id);
        if (ws) try { ws.send(JSON.stringify({ type: 'main_device_changed' })); } catch (_) { /* Reconnect refreshes metadata. */ }
    }
    res.json({ status: 'ok', deleted: selected.length });
});

/**
 * Changes this phone's account-wide sync participation. Signing in and
 * syncing are deliberately separate decisions: local-only clients still
 * route, but never appear in another phone's restore inventory.
 */
app.post('/api/v1/sync/device-mode', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    const legacyEnabled = req.body && req.body.enabled === true;
    const sessionsEnabled = req.body && typeof req.body.sessionsEnabled === 'boolean'
        ? req.body.sessionsEnabled
        : legacyEnabled;
    const cookiesEnabled = sessionsEnabled && (req.body && typeof req.body.cookiesEnabled === 'boolean'
        ? req.body.cookiesEnabled
        : legacyEnabled);
    await store.setDeviceSyncEnabled(device.id, device.accountId, sessionsEnabled);
    if (sessionsEnabled) await store.publishDeviceClients(device.accountId, device.id);
    await store.setDeviceCookieSyncEnabledGlobal(device.id, device.accountId, cookiesEnabled);
    if (!cookiesEnabled) {
        const accountClients = await store.listClients(device.accountId);
        for (const client of accountClients) {
            if (boundDeviceIds(client).includes(device.id)) {
                await store.setDeviceCookieSyncEnabled(client.id, device.id, device.accountId, false);
            }
        }
    }
    await refreshRegistryCache();
    const current = devices.get(device.id);
    res.json({
        status: 'ok',
        syncEnabled: sessionsEnabled,
        sessionSyncEnabled: sessionsEnabled,
        cookieSyncEnabled: cookiesEnabled,
        ...(await accountSyncSnapshot(current))
    });
});

/**
 * Resolves the only destructive transition: a phone that was local-only is
 * joining an account which already has cloud sessions. The decision is made
 * explicitly on the phone; the relay only applies that selected direction.
 */
app.post('/api/v1/sync/resolve', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    const strategy = String((req.body && req.body.strategy) || '');
    if (strategy !== 'cloud' && strategy !== 'device') {
        return res.status(400).json({ error: 'invalid_strategy', message: 'Geçerli bir senkronizasyon yönü seçin.' });
    }

    const accountId = device.accountId;
    const account = await store.getAccountById(accountId);
    if (strategy === 'device' && account?.defaultDeviceId !== device.id) {
        return res.status(403).json({ error: 'not_main_device', message: 'Yedek cihaz bulut kaydını değiştiremez. Önce bu telefonu ana cihaz seçin.' });
    }
    // Enabling sync never deletes another phone's connections or local profiles.

    await store.setDeviceSyncEnabled(device.id, accountId, true);
    await refreshRegistryCache();
    const current = devices.get(device.id);
    addLog(null, 'Uygulama', device.id, 'Senkronizasyon Yönü Seçildi', 'warning',
        strategy === 'cloud' ? 'Bulut verileri bu telefona uygulandı.' : 'Bu telefonun verileri bulut için kaynak seçildi.');
    res.json({ status: 'ok', strategy, ...(await accountSyncSnapshot(current)) });
});

/**
 * An origin backup may explicitly publish one local connection. When the
 * owner asks to include its current cookies, they are stored in a separate,
 * single-use handoff slot. They never enter the normal main-writer path until
 * the selected main phone has applied and accepted the encrypted package.
 */
app.post('/api/v1/sync/clients/:clientId/publish', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    if (!device.syncEnabled) return res.status(409).json({ error: 'device_sync_disabled', message: 'Önce bu telefonda AI oturumu eşitlemesini açın.' });
    const body = req.body || {};
    const allowed = ['cookieSyncEnabled', 'cookieHandoff'];
    if (Object.keys(body).some(k => !allowed.includes(k)) || typeof body.cookieSyncEnabled !== 'boolean') {
        return res.status(400).json({ error: 'invalid_publish_request', message: 'Oturum eşitleme isteği geçersiz.' });
    }
    const clientId = String(req.params.clientId || '');
    const client = await store.getClient(clientId);
    if (!client || client.accountId !== device.accountId || client.deviceId !== device.id ||
        !boundDeviceIds(client).includes(device.id)) {
        return res.status(403).json({ error: 'not_credential_origin', message: 'Bir oturumu buluta yalnızca onu oluşturan cihaz ekleyebilir.' });
    }
    let handoff = null;
    if (body.cookieHandoff != null) {
        if (!body.cookieSyncEnabled || !device.cookieSyncEnabled) {
            return res.status(409).json({ error: 'device_cookie_sync_disabled', message: 'Yerel çerezleri devretmek için bu telefonda çerez eşitlemesini açın.' });
        }
        const h = body.cookieHandoff;
        const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
        if (!h || Object.keys(h).some(k => !['version', 'iv', 'ciphertext', 'cookieKeyRevision'].includes(k)) ||
            h.version !== 2 || typeof h.iv !== 'string' || h.iv.length < 16 || h.iv.length > 64 || !base64.test(h.iv) ||
            typeof h.ciphertext !== 'string' || h.ciphertext.length < 24 || h.ciphertext.length > 350_000 || !base64.test(h.ciphertext) ||
            !Number.isSafeInteger(h.cookieKeyRevision) || h.cookieKeyRevision < 0) {
            return res.status(400).json({ error: 'invalid_cookie_handoff', message: 'Şifreli çerez devir paketi geçersiz.' });
        }
        handoff = { version: 2, iv: h.iv, ciphertext: h.ciphertext,
            cookieKeyRevision: h.cookieKeyRevision, updatedAt: Date.now() };
    }
    const stored = await store.publishClientFromOrigin(device.accountId, device.id, clientId,
        body.cookieSyncEnabled, handoff);
    if (!stored) return res.status(409).json({ error: 'publish_conflict', message: 'Hesap, eşitleme veya şifreleme anahtarı değişti. Bilgileri yenileyip tekrar deneyin.' });
    await refreshRegistryCache();
    await notifyAccountSyncChanged(device.accountId);
    res.json({ status: 'ok', clientId, handoffQueued: !!handoff });
});

app.post('/api/v1/sync/clients/:clientId/cookies/handoff/accept', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    const generation = Number(req.body?.generation);
    const updatedAt = Number(req.body?.updatedAt);
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 1) {
        return res.status(400).json({ error: 'invalid_handoff_acceptance', message: 'Çerez devir onayı geçersiz.' });
    }
    const accepted = await store.acceptCookieHandoff(device.accountId, device.id,
        String(req.params.clientId || ''), generation, updatedAt);
    if (!accepted) return res.status(409).json({ error: 'handoff_changed', message: 'Ana cihaz, oturum bağlantısı veya devir paketi değişti. Yenileyip tekrar deneyin.' });
    await notifyAccountSyncChanged(device.accountId);
    res.json({ status: 'ok', clientId: accepted.clientId, updatedAt: accepted.updatedAt });
});

/**
 * Stores one opaque cookie package. Only the current cookie-origin device may
 * replace it. Other account devices continuously read the package but never
 * race to overwrite one another.
 */
app.put('/api/v1/sync/clients/:clientId/cookies', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({
            error: 'not_linked',
            message: 'Çerez eşitlemek için önce hesabınıza giriş yapın.'
        });
    }
    if (!device.syncEnabled || !device.cookieSyncEnabled) {
        return res.status(409).json({
            error: 'device_cookie_sync_disabled',
            message: 'Bu telefonda çerez senkronizasyonu kapalı. Önce Hesabınız bölümünden açın.'
        });
    }

    const clientId = String(req.params.clientId || '');
    const client = await store.getClient(clientId);
    if (!client || client.accountId !== device.accountId) {
        return res.status(404).json({ error: 'not_found', message: 'Bu AI oturumu hesabınızda bulunamadı.' });
    }
    const main = await store.getAccountById(device.accountId);
    if (main?.cookieKeyEnvelope && (Number(req.body?.cookieKeyRevision) !== main.cookieKeyRevision || req.body?.version !== 2)) {
        return res.status(409).json({ error: 'cookie_key_changed', message: 'Yedek anahtarı değişti. Güncel uygulamada hesap bilgilerini yenileyin; gerekirse tekrar giriş yapın.' });
    }
    if (main?.defaultDeviceId !== device.id || !boundDeviceIds(client).includes(device.id)) {
        return res.status(403).json({
            error: 'not_origin_device',
            message: 'Çerez paketini yalnızca seçili ana cihaz güncelleyebilir.'
        });
    }
    if (!client.cookieSyncEnabled) {
        return res.status(409).json({
            error: 'cookie_sync_disabled',
            message: 'Bu AI oturumu için bulut çerez eşitlemesi kapalı. Önce uygulamadan yeniden açın.'
        });
    }

    const version = Number(req.body && req.body.version);
    const iv = String((req.body && req.body.iv) || '');
    const ciphertext = String((req.body && req.body.ciphertext) || '');
    const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
    if (![1, 2].includes(version) || iv.length < 16 || iv.length > 64 || !base64.test(iv)) {
        return res.status(400).json({ error: 'invalid_snapshot', message: 'Şifreli çerez paketinin sürümü veya IV alanı geçersiz.' });
    }
    if (ciphertext.length < 24 || ciphertext.length > 350_000 || !base64.test(ciphertext)) {
        return res.status(413).json({ error: 'invalid_snapshot', message: 'Şifreli çerez paketi geçersiz veya çok büyük.' });
    }

    const stored = await store.writeMainCookieSnapshot({
        clientId,
        accountId: device.accountId,
        sourceDeviceId: device.id,
        version,
        iv,
        ciphertext,
        cookieKeyRevision: Number(req.body?.cookieKeyRevision),
        updatedAt: Date.now()
    }, Number(req.body?.generation));
    if (!stored) return res.status(409).json({ error: 'main_not_ready', message: 'Ana cihaz veya eşitleme ayarı değişti. Uygulamada eşitlemeyi yenileyin.' });
    res.json({ status: 'ok', clientId, version: stored.version, updatedAt: stored.updatedAt });
});

app.delete('/api/v1/sync/clients/:clientId/cookies', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    const clientId = String(req.params.clientId || '');
    const client = await store.getClient(clientId);
    if (!client || client.accountId !== device.accountId) {
        return res.status(404).json({ error: 'not_found', message: 'Bu AI oturumu hesabınızda bulunamadı.' });
    }
    const account = await store.getAccountById(device.accountId);
    if (account?.defaultDeviceId !== device.id || !account.mainReady || !device.syncEnabled) {
        return res.status(403).json({ error: 'not_main_device', message: 'Bulut kopyasını yalnızca eşitlemesi açık ana cihaz silebilir.' });
    }
    if (!await store.deleteMainCookieSnapshot(device.accountId, device.id, clientId, Number(req.body?.generation))) {
        return res.status(409).json({ error: 'main_device_changed', message: 'Ana cihaz veya eşitleme ayarı değişti; uygulamadan tekrar deneyin.' });
    }
    await refreshRegistryCache();
    res.json({ status: 'ok', clientId });
});

app.post('/api/v1/sync/clients/:clientId/cookies/enable', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    if (!device.syncEnabled || !device.cookieSyncEnabled) {
        return res.status(409).json({
            error: 'device_cookie_sync_disabled',
            message: 'Bu telefonda çerez senkronizasyonu kapalı. Önce Hesabınız bölümünden açın.'
        });
    }
    const clientId = String(req.params.clientId || '');
    const client = await store.getClient(clientId);
    if (!client || client.accountId !== device.accountId || !boundDeviceIds(client).includes(device.id)) {
        return res.status(404).json({ error: 'not_found', message: 'Bu AI oturumu bu telefona bağlı değil.' });
    }
    const account = await store.getAccountById(device.accountId);
    if (account?.defaultDeviceId === device.id) {
        await store.setClientCookieSyncEnabled(clientId, device.accountId, true);
    }
    await store.setDeviceCookieSyncEnabled(clientId, device.id, device.accountId, true);
    await refreshRegistryCache();
    res.json({ status: 'ok', clientId });
});

app.post('/api/v1/sync/clients/:clientId/cookies/disable-device', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    const clientId = String(req.params.clientId || '');
    const changed = await store.setDeviceCookieSyncEnabled(clientId, device.id, device.accountId, false);
    if (!changed) {
        return res.status(404).json({ error: 'not_found', message: 'Bu AI oturumu bu telefona bağlı değil.' });
    }
    await refreshRegistryCache();
    res.json({ status: 'ok', clientId });
});

app.get('/api/v1/devices', async (req, res) => {
    const snapshot = await requireAccountSync(req, res);
    if (snapshot) res.json({ devices: snapshot.devices });
});

app.delete('/api/v1/devices/:deviceId', async (req, res) => {
    const current = requireDevice(req, res);
    if (!current) return;
    if (!current.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Önce hesabınıza giriş yapın.' });
    }
    const targetId = String(req.params.deviceId || '');
    if (!targetId || targetId === current.id) {
        return res.status(400).json({
            error: 'invalid_device',
            message: 'Bu telefonu buradan kaldıramazsınız; çıkış düğmesini kullanın.'
        });
    }
    const target = await store.getDevice(targetId);
    if (!target || target.accountId !== current.accountId) {
        return res.status(404).json({ error: 'not_found', message: 'Cihaz hesabınızda bulunamadı.' });
    }
    // Capture account ownership before unlinking; afterwards accountIdFor()
    // correctly sees an unclaimed device and the event would have no owner.
    addLog(null, 'Uygulama', targetId, 'Cihaz Kaldırıldı', 'warning', 'Hesap sahibi cihazın bağını uzaktan kaldırdı.');
    await store.setDeviceAccount(targetId, null);
    await refreshRegistryCache();
    const socket = browsers.get(targetId);
    if (socket) try { socket.close(4403, 'Cihaz hesap sahibi tarafından kaldırıldı'); } catch (e) {}
    res.json({ status: 'ok', deviceId: targetId });
});

app.get('/api/v1/clients', async (req, res) => {
    const snapshot = await requireAccountSync(req, res);
    if (snapshot) res.json({ clients: snapshot.clients });
});

app.post('/api/v1/logout', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.json({ linked: false, deviceId: device.id });

    addLog(null, 'Uygulama', device.id, 'Cihaz Bağı Koparıldı', 'info', 'Kullanıcı uygulamadan çıkış yaptı.');
    await store.setDeviceAccount(device.id, null);
    await refreshRegistryCache();
    res.json({ linked: false, deviceId: device.id });
});

app.post('/api/v1/account/password', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) {
        return res.status(403).json({ error: 'not_linked', message: 'Bu cihaz bir hesaba bağlı değil.' });
    }

    const account = await store.getAccountById(device.accountId);
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');

    const ok = account && await accounts.verifyPassword(current, account.passwordHash, account.passwordSalt);
    if (!ok) return res.status(401).json({ error: 'bad_credentials', message: 'Mevcut parola hatalı.' });

    const issue = accounts.passwordProblem(next);
    if (issue) return res.status(400).json({ error: 'weak_password', message: issue });

    const { passwordHash, passwordSalt } = await accounts.hashPassword(next);
    const suppliedEnvelope = req.body?.cookieKeyEnvelope || null;
    const validEnvelopePart = (part) => part && /^[A-Za-z0-9+/]{16}$/.test(part.iv || '') &&
        /^[A-Za-z0-9+/]{64}$/.test(part.ciphertext || '');
    const validLegacy = suppliedEnvelope?.version === 1 && validEnvelopePart(suppliedEnvelope);
    const validStrong = suppliedEnvelope?.version === 2 && validEnvelopePart(suppliedEnvelope.strong) &&
        suppliedEnvelope.legacy?.version === 1 && validEnvelopePart(suppliedEnvelope.legacy);
    if (suppliedEnvelope && !validLegacy && !validStrong) {
        return res.status(400).json({ error: 'invalid_key_envelope', message: 'Şifreli anahtar paketi geçersiz.' });
    }
    if (account.cookieKeyEnvelope?.version === 2 && suppliedEnvelope?.version !== 2) {
        return res.status(409).json({
            error: 'key_envelope_upgrade_required',
            message: 'Yedek anahtarı güçlendirilmiş biçimde saklanıyor. Parolayı değiştirmek için uygulamayı güncelleyin.'
        });
    }
    const envelope = validStrong ? {
        version: 2,
        strong: { iv: suppliedEnvelope.strong.iv, ciphertext: suppliedEnvelope.strong.ciphertext },
        legacy: { version: 1, iv: suppliedEnvelope.legacy.iv, ciphertext: suppliedEnvelope.legacy.ciphertext }
    } : validLegacy ? {
        version: 1,
        iv: suppliedEnvelope.iv,
        ciphertext: suppliedEnvelope.ciphertext
    } : null;
    const revision = req.body?.cookieKeyRevision ?? 0;
    if (!Number.isSafeInteger(revision) || !await store.changePasswordWithCookieKey(account.id,
        account.passwordHash, passwordHash, passwordSalt, envelope, revision)) {
        return res.status(409).json({ error: 'cookie_key_migration_required',
            message: 'Parola veya yedek anahtarı değişti. Güncel uygulamada işlemi yeniden başlatın; yedekler korunmuştur.' });
    }
    await store.revokeAccountSessions(account.id);
    if (req.body && req.body.logoutOtherDevices === true) {
        const accountDevices = await store.listDevices(account.id);
        for (const other of accountDevices) {
            if (other.id === device.id) continue;
            addLog(null, 'Uygulama', other.id, 'Cihaz Bağı Koparıldı', 'warning', 'Parola değiştirildi; diğer cihazın hesap bağlantısı kapatıldı.');
            await store.setDeviceAccount(other.id, null);
            const socket = browsers.get(other.id);
            if (socket) try { socket.close(4403, 'Parola değiştirildi; diğer cihazların oturumu kapatıldı'); } catch (e) {}
        }
    }
    await refreshRegistryCache();
    res.json({ status: 'ok', message: 'Parola değişti.' });
});

app.get('/api/v1/audit', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.json({ events: [] });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const events = await store.listAudit(device.accountId, { limit });
    res.json({ events });
});

// ----------------------------------------------------
// CONTROL PANEL
//
// Server-rendered, session-gated, and scoped to one account everywhere. The
// old console had a single shared token and showed every device on the relay
// plus a live feed of the hosts each one was visiting. With accounts that is
// not a convenience any more, it is one tenant reading another's browsing.
//
// Every query below filters by `session.accountId`. A query here without that
// filter is a data leak, not a bug in presentation — treat it that way.
// ----------------------------------------------------

function panelHeaders(res) {
    // No script at all on these pages, so the strictest policy is also the
    // simplest one. Data rendered here is device and client names other people
    // chose; nothing should be in a position to run it.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Resolves the panel session, or null. Also refreshes `last_seen_at`. */
async function currentSession(req) {
    const cookies = accounts.parseCookies(req);
    const token = cookies[accounts.SESSION_COOKIE];
    if (!token) return null;
    const session = await store.getWebSession(accounts.sessionIdHash(token));
    if (!accounts.sessionIsUsable(session)) return null;
    const account = await store.getAccountById(session.accountId);
    if (!account || account.status !== 'active') return null;
    if (!session.lastSeenAt || Date.now() - session.lastSeenAt > 60000) {
        store.touchWebSession(session.idHash, Date.now()).catch(() => {});
    }
    return { session, account, csrf: cookies[accounts.CSRF_COOKIE] || '' };
}

/**
 * Double-submit CSRF check.
 *
 * `SameSite=Lax` already blocks cross-site POSTs in current browsers; this is
 * the belt to that pair of braces, and it costs one hidden field.
 */
function csrfOk(req, ctx) {
    const sent = String((req.body && req.body._csrf) || '');
    return !!ctx.csrf && accounts.safeEquals(sent, ctx.csrf);
}

async function requirePanelSession(req, res) {
    const ctx = await currentSession(req);
    if (!ctx) {
        res.redirect(303, '/login');
        return null;
    }
    return ctx;
}

function ensureCsrfCookie(req, res, existing) {
    if (existing) return existing;
    const token = accounts.newCsrfToken();
    accounts.setCsrfCookie(req, res, token);
    return token;
}

// --- auth pages ---

app.get(['/login', '/register'], async (req, res) => {
    const ctx = await currentSession(req);
    if (ctx) return res.redirect(303, '/');
    const cookies = accounts.parseCookies(req);
    const csrf = ensureCsrfCookie(req, res, cookies[accounts.CSRF_COOKIE]);
    const mode = req.path === '/register' ? 'register' : 'login';
    if (mode === 'register' && !ALLOW_REGISTRATION) {
        panelHeaders(res);
        return res.send(panel.renderLogin({
            mode: 'login', csrf,
            error: 'Bu röle yeni kayıtlara kapalı.'
        }));
    }
    panelHeaders(res);
    res.send(panel.renderLogin({ mode, csrf, notice: req.query.ok ? 'Hesabınız oluşturuldu, giriş yapabilirsiniz.' : '' }));
});

app.post('/auth/register', async (req, res) => {
    const cookies = accounts.parseCookies(req);
    const csrf = ensureCsrfCookie(req, res, cookies[accounts.CSRF_COOKIE]);
    const fail = (message, email) => {
        panelHeaders(res);
        res.status(400).send(panel.renderLogin({ mode: 'register', csrf, error: message, email }));
    };

    if (!ALLOW_REGISTRATION) return fail('Bu röle yeni kayıtlara kapalı.');
    if (!accounts.safeEquals(String((req.body && req.body._csrf) || ''), csrf)) {
        return fail('Form doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.');
    }

    const gate = limits.hit('register', limits.clientIp(req));
    if (!gate.allowed) {
        res.setHeader('Retry-After', String(gate.retryAfterSeconds));
        return fail('Çok fazla kayıt denemesi. Bir süre sonra tekrar deneyin.');
    }

    const email = accounts.normaliseEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');

    const emailIssue = accounts.emailProblem(email);
    if (emailIssue) return fail(emailIssue, email);
    const passwordIssue = accounts.passwordProblem(password);
    if (passwordIssue) return fail(passwordIssue, email);

    const existing = await store.getAccountByEmail(email);
    if (existing) {
        // Same wording as a bad password on login, for the same reason: this
        // form must not become a way to test which addresses have accounts.
        return fail('Bu e-posta ile kayıt oluşturulamadı.', email);
    }

    const { passwordHash, passwordSalt } = await accounts.hashPassword(password);
    const account = await store.createAccount({ email, passwordHash, passwordSalt });
    if (ADMIN_EMAILS.includes(email)) {
        await store.setAccountAdmin(account.id, true);
        console.log(`[Auth] Yönetici hesabı: ${email}`);
    }
    console.log(`[Auth] Yeni hesap: ${account.id}`);
    res.redirect(303, '/login?ok=1');
});

app.post('/auth/login', async (req, res) => {
    const cookies = accounts.parseCookies(req);
    const csrf = ensureCsrfCookie(req, res, cookies[accounts.CSRF_COOKIE]);
    const email = accounts.normaliseEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');

    const fail = (message) => {
        panelHeaders(res);
        res.status(401).send(panel.renderLogin({ mode: 'login', csrf, error: message, email }));
    };

    if (!accounts.safeEquals(String((req.body && req.body._csrf) || ''), csrf)) {
        return fail('Form doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.');
    }

    // Two counters: one per address so a single account cannot be ground down,
    // one per address+IP so a shared office address is not locked out by a
    // neighbour's typo.
    const ip = limits.clientIp(req);
    for (const key of [`e:${email}`, `i:${ip}`]) {
        const gate = limits.hit('login', key);
        if (!gate.allowed) {
            res.setHeader('Retry-After', String(gate.retryAfterSeconds));
            return fail(`Çok fazla giriş denemesi. ${gate.retryAfterSeconds} saniye sonra tekrar deneyin.`);
        }
    }

    const account = await store.getAccountByEmail(email);
    const ok = account && await accounts.verifyPassword(password, account.passwordHash, account.passwordSalt);
    if (!ok) {
        // One message for "no such account" and "wrong password": telling them
        // apart turns this form into an address oracle.
        return fail('E-posta veya parola hatalı.');
    }
    if (account.status !== 'active') {
        return fail('Bu hesap askıya alınmış.');
    }

    limits.reset('login', `e:${email}`);
    limits.reset('login', `i:${ip}`);

    const token = accounts.newSessionToken();
    await store.createWebSession({
        idHash: accounts.sessionIdHash(token),
        accountId: account.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + accounts.SESSION_TTL_MS,
        lastSeenAt: Date.now(),
        userAgentHash: accounts.sha256(String(req.headers['user-agent'] || '')).substring(0, 32)
    });
    accounts.setSessionCookie(req, res, token);
    accounts.setCsrfCookie(req, res, accounts.newCsrfToken());
    res.redirect(303, '/');
});

app.post('/auth/logout', async (req, res) => {
    const cookies = accounts.parseCookies(req);
    const token = cookies[accounts.SESSION_COOKIE];
    if (token) await store.revokeWebSession(accounts.sessionIdHash(token));
    accounts.clearAuthCookies(req, res);
    res.redirect(303, '/login');
});

// --- overview ---

/**
 * Requires an operator. A normal account gets told, politely, that its home is
 * the app — not a 403, because it is not an error for a user to have wandered
 * here once.
 */
async function requireOperator(req, res) {
    const ctx = await requirePanelSession(req, res);
    if (!ctx) return null;
    if (!ctx.account.isAdmin) {
        const csrf = ensureCsrfCookie(req, res, ctx.csrf);
        panelHeaders(res);
        res.status(200).send(panel.renderNotOperator({ email: ctx.account.email, csrf }));
        return null;
    }
    return ctx;
}

app.get('/', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    const csrf = ensureCsrfCookie(req, res, ctx.csrf);
    const window = limits.currentUsageWindow();

    const [totals, accountRows, ownDevices, ownClients] = await Promise.all([
        store.aggregates(window),
        store.listAccounts({ limit: 300 }),
        store.listDevices(ctx.account.id),
        store.listClients(ctx.account.id)
    ]);
    const usageByAccount = await store.usageForAccounts(accountRows.map((a) => a.id), window);

    panelHeaders(res);
    res.send(panel.renderOperatorOverview({
        account: ctx.account,
        totals,
        accountRows,
        usageByAccount,
        ownDevices,
        ownClients,
        connectedDeviceIds: [...browsers.keys()],
        openChannels: sseSessions.size,
        csrf,
        registrationOpen: ALLOW_REGISTRATION,
        error: req.query.err ? String(req.query.err).substring(0, 200) : '',
        notice: req.query.ok ? String(req.query.ok).substring(0, 200) : '',
        storeWarning: store.durable ? '' :
            'Bu röle kalıcı bir veritabanı olmadan çalışıyor (DATABASE_URL tanımlı değil). Hesaplar ve cihaz bağları bir sonraki dağıtımda kaybolabilir.'
    }));
});

/**
 * Suspending an account.
 *
 * Takes effect on the next command, not the next pairing: `requireAuth` reads
 * the cached account and refuses a suspended one, and open SSE channels for the
 * account are closed here. Suspension that a running agent does not notice is
 * not suspension.
 */
app.post('/admin/accounts/status', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const accountId = String((req.body && req.body.accountId) || '').trim();
    const status = String((req.body && req.body.status) || '').trim();
    if (!['active', 'suspended'].includes(status)) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Geçersiz durum.'));
    }
    if (accountId === ctx.account.id && status === 'suspended') {
        return res.redirect(303, '/?err=' + encodeURIComponent('Kendi hesabınızı askıya alamazsınız.'));
    }

    const updated = await store.setAccountStatus(accountId, status);
    if (!updated) return res.redirect(303, '/?err=' + encodeURIComponent('Hesap bulunamadı.'));
    await refreshRegistryCache();

    if (status === 'suspended') {
        sseSessions.forEach((sess, id) => {
            if (sess.accountId === accountId) {
                try { sess.res.end(); } catch (e) {}
                sseSessions.delete(id);
            }
        });
        await store.revokeAccountSessions(accountId);
    }

    console.log(`[Admin] ${updated.email} durumu: ${status}`);
    res.redirect(303, '/?ok=' + encodeURIComponent(`${updated.email} → ${status}`));
});

app.post('/admin/accounts/plan', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const accountId = String((req.body && req.body.accountId) || '').trim();
    const plan = String((req.body && req.body.plan) || '').trim();
    if (!Object.prototype.hasOwnProperty.call(limits.PLANS, plan)) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Geçersiz plan.'));
    }

    const updated = await store.setAccountPlan(accountId, plan);
    if (!updated) return res.redirect(303, '/?err=' + encodeURIComponent('Hesap bulunamadı.'));
    await refreshRegistryCache();

    console.log(`[Admin] ${updated.email} planı: ${plan}`);
    res.redirect(303, '/?ok=' + encodeURIComponent(`${updated.email} → ${plan}`));
});

// --- operator-managed recommended sites ---

function quickLinkRedirect(message, error = false) {
    return '/admin/quick-links?' + (error ? 'err=' : 'ok=') + encodeURIComponent(message);
}

function quickLinkInput(body, id, category) {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').substring(0, 80);
    const description = String(body.description || '').trim().replace(/\s+/g, ' ').substring(0, 240);
    const rawUrl = String(body.url || '').trim();
    if (!category || !name || !rawUrl || !description) {
        throw new Error('Kategori, site adı, bağlantı ve AI açıklaması zorunludur.');
    }
    if (rawUrl.length > 2048) throw new Error('Bağlantı en fazla 2048 karakter olabilir.');

    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) { throw new Error('Geçerli bir HTTPS bağlantısı girin.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error('Yalnızca kullanıcı adı veya parola içermeyen HTTPS bağlantıları kabul edilir.');
    }

    const order = (value, label) => {
        const n = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`${label} 0–9999 arasında olmalıdır.`);
        return n;
    };

    return {
        id,
        categoryId: category.id,
        category: category.title,
        categoryOrder: category.sortOrder,
        name,
        url: parsed.toString(),
        description,
        sortOrder: order(body.sortOrder, 'Site sırası'),
        active: String(body.active) === '1'
    };
}

function quickLinkCategoryInput(body, id) {
    const title = String(body.title || '').trim().replace(/\s+/g, ' ').substring(0, 60);
    const sortOrder = Number.parseInt(String(body.sortOrder ?? ''), 10);
    if (!title) throw new Error('Kategori adı zorunludur.');
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
        throw new Error('Kategori sırası 0–9999 arasında olmalıdır.');
    }
    return { id, title, sortOrder };
}

app.get('/admin/quick-links', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    const csrf = ensureCsrfCookie(req, res, ctx.csrf);
    const [catalogue, categories] = await Promise.all([
        store.listQuickLinks({ includeInactive: true }),
        store.listQuickLinkCategories()
    ]);
    panelHeaders(res);
    res.send(panel.renderQuickLinks({
        account: ctx.account,
        catalogue,
        categories,
        csrf,
        error: req.query.err ? String(req.query.err).substring(0, 200) : '',
        notice: req.query.ok ? String(req.query.ok).substring(0, 200) : ''
    }));
});

app.post('/admin/quick-links/save', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, quickLinkRedirect('Form doğrulaması başarısız.', true));

    const suppliedId = String((req.body && req.body.id) || '').trim();
    if (suppliedId && !/^[a-zA-Z0-9_-]{1,80}$/.test(suppliedId)) {
        return res.redirect(303, quickLinkRedirect('Geçersiz kısayol kimliği.', true));
    }
    if (suppliedId && !(await store.getQuickLink(suppliedId))) {
        return res.redirect(303, quickLinkRedirect('Düzenlenecek site artık mevcut değil.', true));
    }

    try {
        const categoryId = String((req.body && req.body.categoryId) || '').trim();
        const category = categoryId && await store.getQuickLinkCategory(categoryId);
        if (!category) throw new Error('Seçilen kategori bulunamadı. Önce kategoriyi oluşturun.');
        const id = suppliedId || `shortcut_${randomUUID()}`;
        const input = quickLinkInput(req.body || {}, id, category);
        await store.upsertQuickLink(input);
        await broadcastQuickLinkCatalogue();
        console.log(`[Admin] Hızlı link kaydedildi: ${input.category} / ${input.name}`);
        res.redirect(303, quickLinkRedirect(`${input.name} kaydedildi.`));
    } catch (e) {
        res.redirect(303, quickLinkRedirect(e.message || 'Site kaydedilemedi.', true));
    }
});

app.post('/admin/quick-links/categories/save', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, quickLinkRedirect('Form doğrulaması başarısız.', true));

    const suppliedId = String((req.body && req.body.id) || '').trim();
    if (suppliedId && !/^[a-zA-Z0-9_-]{1,80}$/.test(suppliedId)) {
        return res.redirect(303, quickLinkRedirect('Geçersiz kategori kimliği.', true));
    }
    if (suppliedId && !(await store.getQuickLinkCategory(suppliedId))) {
        return res.redirect(303, quickLinkRedirect('Düzenlenecek kategori artık mevcut değil.', true));
    }

    try {
        const id = suppliedId || `category_${randomUUID()}`;
        const input = quickLinkCategoryInput(req.body || {}, id);
        await store.upsertQuickLinkCategory(input);
        await broadcastQuickLinkCatalogue();
        res.redirect(303, quickLinkRedirect(`${input.title} kategorisi kaydedildi.`));
    } catch (e) {
        res.redirect(303, quickLinkRedirect(e.message || 'Kategori kaydedilemedi.', true));
    }
});

app.post('/admin/quick-links/categories/delete', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, quickLinkRedirect('Form doğrulaması başarısız.', true));

    const id = String((req.body && req.body.id) || '').trim();
    const existing = id && await store.getQuickLinkCategory(id);
    if (!existing) return res.redirect(303, quickLinkRedirect('Silinecek kategori bulunamadı.', true));
    if (!(await store.deleteQuickLinkCategory(id))) {
        return res.redirect(303, quickLinkRedirect('İçinde site bulunan kategori silinemez. Önce siteleri taşıyın veya silin.', true));
    }
    await broadcastQuickLinkCatalogue();
    res.redirect(303, quickLinkRedirect(`${existing.title} kategorisi silindi.`));
});

app.post('/admin/quick-links/delete', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, quickLinkRedirect('Form doğrulaması başarısız.', true));

    const id = String((req.body && req.body.id) || '').trim();
    const existing = id && await store.getQuickLink(id);
    if (!existing || !(await store.deleteQuickLink(id))) {
        return res.redirect(303, quickLinkRedirect('Silinecek site bulunamadı.', true));
    }
    await broadcastQuickLinkCatalogue();
    console.log(`[Admin] Hızlı link silindi: ${existing.category} / ${existing.name}`);
    res.redirect(303, quickLinkRedirect(`${existing.name} silindi.`));
});

app.post('/devices/claim', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const gate = limits.hit('claim', `a:${ctx.account.id}`);
    if (!gate.allowed) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Çok fazla deneme. Biraz sonra tekrar deneyin.'));
    }

    const plan = limits.planFor(ctx.account);
    const owned = await store.countDevices(ctx.account.id);
    if (owned >= plan.maxDevices) {
        return res.redirect(303, '/?err=' + encodeURIComponent(
            `${plan.label} planı ${plan.maxDevices} cihazla sınırlı. Yeni bir cihaz bağlamak için önce birinin bağını koparın.`));
    }

    const code = normaliseClaimCode(req.body && req.body.code);
    const claim = code ? await store.consumeClaimCode(code) : null;
    if (!claim) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Kod geçersiz, kullanılmış veya süresi dolmuş. Telefondan yeni bir kod alın.'));
    }

    const device = await store.getDevice(claim.deviceId);
    if (!device) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Kodun ait olduğu cihaz artık kayıtlı değil.'));
    }
    if (device.accountId && device.accountId !== ctx.account.id) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Bu cihaz başka bir hesaba bağlı.'));
    }

    await store.setDeviceAccount(device.id, ctx.account.id);
    await refreshRegistryCache();
    addLog(null, 'Panel', device.id, 'Cihaz Bağlandı', 'success', 'Cihaz hesaba bağlandı.');

    const ws = browsers.get(device.id);
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claim_result', status: 'claimed' })); } catch (e) {}
    }

    res.redirect(303, '/?ok=' + encodeURIComponent('Cihaz hesabınıza bağlandı.'));
});

app.post('/devices/release', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const deviceId = String((req.body && req.body.deviceId) || '').trim();
    const device = await store.getDevice(deviceId);
    if (!device || device.accountId !== ctx.account.id) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Bu cihaz sizin hesabınıza bağlı değil.'));
    }

    addLog(null, 'Panel', deviceId, 'Cihaz Bağı Koparıldı', 'info', 'Cihaz hesaptan ayrıldı.');
    await store.setDeviceAccount(deviceId, null);
    await refreshRegistryCache();

    const ws = browsers.get(deviceId);
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claim_result', status: 'released' })); } catch (e) {}
    }

    res.redirect(303, '/?ok=' + encodeURIComponent('Cihazın bağı koparıldı.'));
});

app.post('/clients/revoke', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const clientId = String((req.body && req.body.clientId) || '').trim();
    const record = await store.getClient(clientId);
    if (!record || record.accountId !== ctx.account.id) {
        return res.redirect(303, '/?err=' + encodeURIComponent('Bu istemci sizin hesabınıza bağlı değil.'));
    }

    await store.deleteClient(clientId);
    clients.delete(clientId);

    // Cut any channel the key is holding open right now. Revocation that only
    // takes effect on the next connection is not revocation.
    sseSessions.forEach((sess, id) => {
        if (sess.clientId === clientId) {
            try { sess.res.end(); } catch (e) {}
            sseSessions.delete(id);
        }
    });

    // Tell every bound phone so none keeps accepting the revoked credential.
    boundDeviceIds(record).forEach((deviceId) => {
        const ws = browsers.get(deviceId);
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'client_revoked', clientId })); } catch (e) {}
        }
    });

    addLog(clientId, record.name, record.deviceId, 'İstemci İptal Edildi', 'info', 'Panelden iptal edildi.');
    res.redirect(303, '/?ok=' + encodeURIComponent('İstemci erişimi iptal edildi.'));
});

// --- audit ---

app.get('/audit', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;

    const filters = {
        deviceId: String(req.query.deviceId || '').trim() || null,
        clientId: String(req.query.clientId || '').trim() || null
    };
    const [events, deviceList, clientList] = await Promise.all([
        store.listAudit(ctx.account.id, { limit: 300, ...filters }),
        store.listDevices(ctx.account.id),
        store.listClients(ctx.account.id)
    ]);

    panelHeaders(res);
    res.send(panel.renderAudit({
        account: ctx.account,
        plan: limits.planFor(ctx.account),
        events,
        devices: deviceList,
        clients: clientList,
        filters
    }));
});

app.get('/audit/export', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;

    const events = await store.listAudit(ctx.account.id, { limit: 5000 });
    const cell = (v) => {
        const text = String(v === null || v === undefined ? '' : v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [['zaman', 'durum', 'eylem', 'cihaz', 'istemci', 'host', 'ayrinti']];
    events.forEach((e) => rows.push([
        new Date(e.createdAt).toISOString(), e.status, e.action,
        e.deviceId || '', e.clientId || '', e.host || '', e.detail || ''
    ]));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="denetim-kaydi.csv"');
    res.send(rows.map((r) => r.map(cell).join(',')).join('\n'));
});

// --- account ---

app.get('/account', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    const csrf = ensureCsrfCookie(req, res, ctx.csrf);
    panelHeaders(res);
    res.send(panel.renderAccount({
        account: ctx.account,
        plan: limits.planFor(ctx.account),
        csrf,
        activeSessions: '—',
        error: req.query.err ? String(req.query.err).substring(0, 200) : '',
        notice: req.query.ok ? String(req.query.ok).substring(0, 200) : ''
    }));
});

app.post('/account/password', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/account?err=' + encodeURIComponent('Form doğrulaması başarısız.'));

    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');

    const ok = await accounts.verifyPassword(current, ctx.account.passwordHash, ctx.account.passwordSalt);
    if (!ok) return res.redirect(303, '/account?err=' + encodeURIComponent('Mevcut parola hatalı.'));

    const issue = accounts.passwordProblem(next);
    if (issue) return res.redirect(303, '/account?err=' + encodeURIComponent(issue));

    const { passwordHash, passwordSalt } = await accounts.hashPassword(next);
    if (!await store.changePasswordWithCookieKey(ctx.account.id, ctx.account.passwordHash,
        passwordHash, passwordSalt, null, ctx.account.cookieKeyRevision || 0)) {
        return res.redirect(303, '/account?err=' + encodeURIComponent('Şifreli yedekleri korumak için parolayı Android uygulamasından değiştirin.'));
    }
    // A password change is also how someone reacts to a stolen laptop, so it
    // has to end every other session, not just change the secret.
    await store.revokeAccountSessions(ctx.account.id, ctx.session.idHash);
    res.redirect(303, '/account?ok=' + encodeURIComponent('Parola değişti; diğer oturumlar kapatıldı.'));
});

app.post('/account/sessions/revoke', async (req, res) => {
    const ctx = await requireOperator(req, res);
    if (!ctx) return;
    if (!csrfOk(req, ctx)) return res.redirect(303, '/account?err=' + encodeURIComponent('Form doğrulaması başarısız.'));
    const n = await store.revokeAccountSessions(ctx.account.id, ctx.session.idHash);
    res.redirect(303, '/account?ok=' + encodeURIComponent(`${n} oturum kapatıldı.`));
});

// The operator's JSON view. Same rule as the console: totals and per-account
// metadata, never another account's audit trail.
app.get('/api/status', async (req, res) => {
    const ctx = await currentSession(req);
    if (!ctx) return res.status(401).json({ error: 'unauthorized', message: 'Panel oturumu gerekli.' });
    if (!ctx.account.isAdmin) {
        return res.status(403).json({
            error: 'not_operator',
            message: 'Bu uç operatörler içindir. Hesabınızı Android uygulamasından yönetin.'
        });
    }

    const window = limits.currentUsageWindow();
    const [totals, accountRows] = await Promise.all([
        store.aggregates(window),
        store.listAccounts({ limit: 300 })
    ]);
    const usageByAccount = await store.usageForAccounts(accountRows.map((a) => a.id), window);

    res.json({
        status: 'running',
        durable_store: store.durable,
        registration_open: ALLOW_REGISTRATION,
        totals,
        connected_devices: browsers.size,
        open_channels: sseSessions.size,
        accounts: accountRows.map((a) => ({
            id: a.id,
            email: a.email,
            plan: a.plan,
            status: a.status,
            is_admin: a.isAdmin,
            devices: a.deviceCount,
            clients: a.clientCount,
            commands_today: usageByAccount.get(a.id) || 0,
            created_at: a.createdAt
        }))
    });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// NOTE: The previous build exposed /oauth/authorize, /oauth/token and
// /oauth/register. They auto-approved every request, handed out one static
// access token that was never checked, and redirected to an unvalidated
// redirect_uri. They have been removed rather than patched: they provided the
// appearance of authorization while granting none. A credential can now only
// be minted on the device itself, which announces the hash over its WebSocket.

// Start listening
const PORT = process.env.PORT || 10000;

/**
 * Audit retention.
 *
 * Kept per plan rather than globally, and swept rather than trimmed on write:
 * a delete pass once an hour is cheaper than a bounds check on every insert,
 * and nobody minds a row living an extra fifty minutes.
 */
const AUDIT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function sweepAudit() {
    try {
        const longest = Math.max(...Object.values(limits.PLANS).map((p) => p.auditRetentionDays));
        const removed = await store.pruneAudit(Date.now() - longest * 86400000);
        if (removed > 0) console.log(`[Audit] ${removed} eski kayıt silindi.`);
    } catch (e) {
        console.warn('[Audit] Temizlik başarısız:', e.message);
    }

    // Dynamic registration lets any client create a record, and clients that
    // register on every reinstall never clean up after themselves. A row here
    // holds no secret, but an unbounded table is still a table nobody trimmed.
    // Idle means idle: `lastUsedAt` is touched on every token exchange, so a
    // connector somebody actually uses is never swept.
    try {
        const removed = await store.pruneOAuthClients(Date.now() - oauth.REGISTRATION_IDLE_MS);
        if (removed > 0) console.log(`[OAuth] ${removed} kullanılmayan istemci kaydı silindi.`);
    } catch (e) {
        console.warn('[OAuth] Kayıt temizliği başarısız:', e.message);
    }
}

async function main() {
    store = await openStore();
    await refreshRegistryCache();

    const unclaimed = [...devices.values()].filter((d) => !d.accountId).length;

    const sweeper = setInterval(sweepAudit, AUDIT_SWEEP_INTERVAL_MS);
    if (sweeper.unref) sweeper.unref();

    server.listen(PORT, () => {
        console.log('=================================================');
        console.log(` MCP Bridge Server listening on port ${PORT}`);
        console.log(` - Panel:    http://localhost:${PORT}/`);
        console.log(` - MCP SSE:  http://localhost:${PORT}/sse   (kimlik doğrulaması gerekli)`);
        console.log(``);
        console.log(` - Depo:     ${store.kind}${store.durable ? '' : ' (kalıcı değil)'}`);
        console.log(` - Kayıtlı:  ${devices.size} cihaz, ${clients.size} istemci`);
        if (unclaimed > 0) {
            console.warn(` ! ${unclaimed} cihaz hiçbir hesaba bağlı değil. Sahipleri panelden bağlayana`);
            console.warn('   kadar panelde görünmezler; komut yönlendirmeye devam ederler.');
        }
        if (!store.durable) {
            console.warn(' ! DATABASE_URL tanımlı değil. Hesaplar ve cihaz bağları bir JSON dosyasında');
            console.warn('   tutuluyor; Render gibi ortamlarda bu dosya her dağıtımda silinir.');
        }
        if (!ALLOW_REGISTRATION) {
            console.log(' - Kayıt:    kapalı (ALLOW_REGISTRATION=false)');
        }
        console.log('=================================================');
    });
}

main().catch((e) => {
    console.error('[Boot] Başlatılamadı:', e.message);
    process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal} alındı, kapanılıyor...`);

    // Flush first: everything below can fail without costing us the registry.
    // `close` is fire-and-forget because the forced-exit timer below is the
    // real deadline — a database that will not close must not hold a deploy.
    if (store) {
        Promise.resolve()
            .then(() => flushAudit())
            .then(() => store.close())
            .catch(() => {});
    }

    // Stop taking new work before tearing down the old.
    server.close(() => {
        console.log('[Shutdown] HTTP sunucusu kapandı.');
        process.exit(0);
    });

    sseSessions.forEach((session, sessionId) => {
        try {
            session.res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/cancelled","params":{"reason":"server_restarting"}}\n\n');
            session.res.end();
        } catch (e) {}
        sseSessions.delete(sessionId);
    });

    // 1001 "going away" tells the phone this is a restart, not a fault, so it
    // reconnects on its normal backoff instead of the stuck-socket path.
    browsers.forEach((ws) => {
        try { ws.close(1001, 'Sunucu yeniden başlatılıyor'); } catch (e) {}
    });
    try { wss.close(); } catch (e) {}

    // Some sockets never finish closing. Do not hold a deploy hostage for them.
    setTimeout(() => {
        console.warn('[Shutdown] Zaman aşımı — süreç zorla sonlandırılıyor.');
        process.exit(0);
    }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
