const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID, createHash, timingSafeEqual, randomInt } = require('crypto');

const fs = require('fs');
const path = require('path');

const { openStore } = require('./lib/store');
const accounts = require('./lib/auth');
const limits = require('./lib/limits');
const panel = require('./lib/panel');

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
const wss = new WebSocketServer({ noServer: true });

// Active connections
const browsers = new Map();        // deviceId -> live WebSocket
const pendingRequests = new Map(); // messageId -> { resolve, reject, timeout }

// ----------------------------------------------------
// IDENTITY REGISTRY
//
// The device is the authority: it mints every clientId/clientSecret and tells
// us only the hash. We keep the hash so we can reject bad credentials early,
// and the clientId -> deviceId binding so a command can never be routed to
// somebody else's phone.
//
// These two Maps are a *read cache* over `lib/store.js`, not the truth. Every
// MCP command calls `authenticate()`, and making that wait on a query would put
// a database round trip in front of every page read. Writes go to the store and
// refresh the cache; the cache is rebuilt at boot.
// ----------------------------------------------------
const devices = new Map(); // deviceId -> { id, accountId, secretHash, name, ... }
const clients = new Map(); // clientId -> { id, deviceId, accountId, secretHash, name }

let store = null;

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
        name: "browser_navigate",
        description: "Android tarayıcısında belirtilen web adresine (URL) gider. Ayrıntılı kılavuz için 'browser_get_tool_documentation' aracını inceleyin.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Gidilecek URL (örn. https://www.google.com)" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel, tek cihaz varsa otomatik seçilir)" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_search",
        description: "Google'da belirtilen anahtar kelimelerle arama yapar ve arama sonuçları sayfasını yükler.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Google'da aranacak kelime veya cümle (örn. 'en ucuz uçak bileti')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["query"]
        }
    },
    {
        name: "browser_screenshot",
        description: "Sekmenin görüntüsünü JPEG olarak alır ve MCP görüntü bloğu olarak döner. Android yalnızca ekranda olan bir WebView'ı çizdiği için: sekme ekrandaysa doğrudan alınır; arka plandaki bir sekme için uygulama telefonda açıksa cihaz o sekmeyi bir anlığına ekrana alır, görüntüyü çeker ve ekranı eski haline döndürür (yanıtta 'captured_by_showing_tab' true olur). Uygulama ön planda değilse 'blank_capture' hatası döner — sayfa yüklüdür, yalnızca çizilmemiştir; içeriği 'browser_get_markdown' ile okuyun. Video, WebGL ve bazı canvas içerikleri ekrandayken bile boş çıkabilir.",
        inputSchema: {
            type: "object",
            properties: {
                fullPage: { type: "boolean", description: "true ise yalnızca görünen alan yerine sayfanın tamamı yakalanır. Telefonda o an ekranda olan sekmede yok sayılır (yanıt 'full_page' alanında hangisinin alındığını bildirir)." },
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
        description: "Belirtilen element ID sayısı (örn. '1' veya '5'), Vimium etiketi, CSS seçici veya metin ('text=Uçuş Ara') ile eşleşen öğeye tıklar.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Tıklanacak elementin ID sayısı (örn. '1'), Vimium etiketi, CSS seçicisi veya metni (örn. 'text=Arama Yap')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector"]
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
        description: "Belirtilen input/text/tarih alanına yazı girer. Selector olarak element ID sayısı (örn. '2'), Vimium ID sayısı veya CSS seçici kullanılabilir.",
        inputSchema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "Yazı girilecek elementin ID sayısı (örn. '2') veya CSS seçicisi" },
                text: { type: "string", description: "Girilecek metin veya tarih (örn. 'İstanbul' veya '2026-08-15')" },
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            },
            required: ["selector", "text"]
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
            tools: ["browser_navigate", "browser_search", "browser_scroll"]
        },
        interaction: {
            name: "Etkileşim, Tıklama & Form Doldurma",
            tools: ["browser_click", "browser_type", "browser_toggle_overlay", "browser_execute_js"]
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
            tools: ["browser_get_tool_documentation"]
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
        browser_navigate: {
            name: "browser_navigate",
            category: "navigation",
            summary: "Belirtilen web adresine (URL) gider ve sayfanın yüklenmesini başlatır.",
            parameters: {
                url: "(Zorunlu, String) Gidilecek tam web adresi (örn. 'https://en.wikipedia.org' veya 'https://news.ycombinator.com'). Her zaman protokolü (https://) ekleyin.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            example_call: { url: "https://www.google.com" },
            best_practice: "Gezinti sonrası içerik okumak için 'browser_get_markdown' aracını çağırın."
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
            best_practice: "Google aramasından sonra arama sonuçlarındaki linkleri ve başlıkları okumak için 'browser_get_markdown' çağırın."
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
                tabId: "(Opsiyonel, String) Hedef sekme; verilmezse oturumun aktif sekmesi.",
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Sayfanın yapısını anlamak için önce 'browser_get_markdown' kullanın — metin hem daha ucuz hem daha kesindir. Ekran görüntüsünü, yerleşimi görmeniz gereken durumlarda (bir öğe gerçekten görünüyor mu, bir grafik neye benziyor, tıklama doğru yere gitti mi) tercih edin. Yanıttaki 'full_page' alanı tam sayfa mı yoksa yalnızca görünen alan mı alındığını söyler; 'browser_toggle_overlay' ile birlikte kullanırsanız tıklanabilir öğelerin numaraları da görüntüde görünür.",
            limitations: "Uygulama ön planda değilken hiçbir sekme çizilmez ve 'blank_capture' döner; bu durumda içeriği metin olarak okuyun. Ekrana alma birkaç yüz milisaniye sürer ve kullanıcının ekranı o an kısaca değişir, bu yüzden döngü içinde çağırmayın. Aynı anda yalnızca bir ekrana alma yapılabilir. Tam sayfa yakalama yalnızca ekran dışı çizimde mümkündür; ekrana alınarak çekilen görüntülerde yalnızca görünen alan gelir. Görüntü 720 piksel genişliğe ölçeklenir ve JPEG olarak sıkıştırılır. Video, WebGL ve GPU ile birleştirilen bazı canvas içerikleri boş çıkabilir."
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
            summary: "Belirtilen element ID numarasına ('1', '5'), CSS seçicisine veya metne ('text=Giriş Yap') tıklar.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı (örn. '3'), CSS seçici (örn. '#btn-submit', 'button.primary') veya metin (örn. 'text=Uçuş Ara')"
            },
            example_call: { selector: "text=Arama Yap" },
            best_practice: "Metinle tıklama ('text=...') veya element numarası ile tıklama ('1') genellikle CSS class isimlerinden çok daha dayanıklıdır."
        },
        browser_type: {
            name: "browser_type",
            category: "interaction",
            summary: "Input veya metin alanına yazı yazar ve gerçek klavye/input olaylarını tetikler.",
            parameters: {
                selector: "(Zorunlu, String) Element ID sayısı (örn. '2'), CSS seçici (örn. 'input[name=\"q\"]') veya 'input'",
                text: "(Zorunlu, String) Girilecek metin (örn. 'Ali Veli' veya '2026-08-15')"
            },
            example_call: { selector: "input[type='search']", text: "Antalya Otelleri" },
            best_practice: "Yazı yazdıktan sonra formu göndermek için ilgili butona 'browser_click' yapın veya 'browser_execute_js' ile form.submit() tetikleyin. Kişisel bilgi alanları (e-posta, telefon, adres, kimlik, doğum tarihi) telefonda kullanıcı onayı ister. Şifre, doğrulama kodu ve ödeme alanları için 'sensitive_fields' izni gerekir; izniniz yoksa kullanıcıdan telefondan açmasını isteyin, izin açıkken de her doldurma için ayrıca onay çıkabilir."
        },
        browser_scroll: {
            name: "browser_scroll",
            category: "navigation",
            summary: "Sayfayı aşağı ('down') veya yukarı ('up') kaydırır.",
            parameters: {
                direction: "(Opsiyonel, String) 'down' veya 'up' (Varsayılan: 'down')"
            },
            best_practice: "Sonsuz kaydırmalı sayfalarda (Twitter, feed'ler) veya ekranın altında kalan butonları görünür yapmak için kullanın."
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
            summary: "Mevcut AI oturumunda yeni bir tarayıcı sekmesi açar.",
            parameters: {
                url: "(Opsiyonel, String) Açılacak URL adresi (Varsayılan: google.com)"
            },
            best_practice: "Mevcut sayfadaki çalışmanızı kaybetmeden yan bir araştırma veya işlem yapmak istediğinizde yeni sekme açın."
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
// one device that minted it; the secret is verified here against the stored
// hash AND again on the device, which is the actual authority.
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
        res.status(401).json({
            error: 'unauthorized',
            message: "Geçerli bir istemci kimliği gerekli. Android uygulamasında Ayarlar → MCP → 'AI istemcisi ekle' ile bir anahtar üretin ve verilen 'Authorization: Bearer <clientId>.<secret>' başlığını MCP yapılandırmanıza ekleyin."
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

// Route a command to the one device this client is bound to. There is no
// fallback to "some other connected device" — that would hand one user's AI
// the controls of another user's phone.
function routeCommandToBrowser(type, args, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const record = clients.get(clientId);
        if (!record) return reject(new Error('İstemci kaydı bulunamadı. Lütfen cihazdan yeniden eşleştirin.'));

        const deviceId = record.deviceId;
        const ws = browsers.get(deviceId);
        if (!ws || ws.readyState !== 1) {
            browsers.delete(deviceId);
            return reject(new Error(`Eşleştirilmiş cihaz (${deviceId}) şu anda çevrimdışı. Android uygulamasının açık ve köprüye bağlı olduğundan emin olun.`));
        }

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
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});


// WebSocket Server Handler (for the Android app)
wss.on('connection', (ws) => {
    let deviceId = null;      // set only after a verified register
    let authenticated = false;

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
                await store.replaceDeviceClients(id, list);
            }
            await store.touchDevice(id, Date.now());
            await refreshRegistryCache();

            const existing = browsers.get(id);
            if (existing && existing !== ws) {
                try { existing.close(1000, 'Yeni bağlantı ile değiştirildi'); } catch (e) {}
            }
            browsers.set(id, ws);

            const record = devices.get(id);
            const mine = [...clients.values()].filter((c) => c.deviceId === id).length;
            addLog(null, 'Android Uygulaması', id, 'Cihaz Bağlandı', 'success', `${mine} eşleştirilmiş istemci bildirildi.`);
            ws.send(JSON.stringify({
                type: 'register_ack',
                deviceId: id,
                status: 'success',
                claimed: !!(record && record.accountId)
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

        // The device minted a credential locally and is telling us the hash so
        // it works immediately, without waiting for the next register.
        if (payload.type === 'client_added') {
            const cid = String(payload.clientId || '').trim();
            const hash = String(payload.secretHash || '').trim();
            if (!cid || !/^[a-f0-9]{64}$/i.test(hash)) return;
            await store.upsertClient({
                id: cid,
                deviceId,
                secretHash: hash,
                name: String(payload.name || 'AI istemcisi').substring(0, 60)
            });
            await refreshRegistryCache();
            addLog(cid, payload.name, deviceId, 'İstemci Eklendi', 'success', 'Cihaz yeni bir erişim anahtarı üretti.');
            return;
        }

        if (payload.type === 'revoke_client') {
            const cid = String(payload.clientId || '').trim();
            const rec = clients.get(cid);
            if (rec && rec.deviceId === deviceId) {
                await store.deleteClient(cid);
                clients.delete(cid);
                addLog(cid, rec.name, deviceId, 'İstemci İptal Edildi', 'info', 'Kullanıcı erişimi kaldırdı.');
            }
            return;
        }

        // The phone asks for a claim code so its owner can attach it to an
        // account. This is the only thing an unclaimed device may do.
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
        if (deviceId && browsers.get(deviceId) === ws) {
            browsers.delete(deviceId);
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

    const plan = limits.planFor(auth.account);
    const openForClient = [...sseSessions.values()].filter((sess) => sess.clientId === auth.clientId).length;
    if (openForClient >= plan.maxSseChannelsPerClient) {
        // An abandoned SSE channel holds a response object open forever; a
        // client that reconnects in a loop without closing would grow the map
        // until the process died.
        return res.status(429).json({
            error: 'too_many_channels',
            message: `Bu anahtar için aynı anda en fazla ${plan.maxSseChannelsPerClient} kanal açılabilir. Kullanılmayan MCP istemcilerini kapatın.`
        });
    }

    sseSessions.set(sessionId, {
        res,
        clientId: auth.clientId,
        deviceId: auth.record.deviceId,
        accountId: auth.record.accountId || null,
        secret: auth.secret,
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

    const rpcRequest = req.body;
    console.log(`[MCP] JSON-RPC from client=${auth.clientId} method=${rpcRequest && rpcRequest.method}`);

    if (!rpcRequest || typeof rpcRequest !== 'object') {
        const errorResponse = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null };
        sendSseJsonRpc(sessionId, errorResponse);
        return res.status(200).send("accepted");
    }

    const { method, params, id } = rpcRequest;

    // Handle notifications (no response required in JSON-RPC, return 202 immediately)
    if (id === undefined || id === null) {
        if (method === 'notifications/initialized') {
            addLog(auth.clientId, session.clientName, auth.record.deviceId, 'Sistem Hazır', 'success', 'MCP el sıkışması tamamlandı.');
        }
        return res.status(202).send("accepted");
    }

    // Helper to send JSON-RPC formatted responses
    const reply = (result, error = null) => {
        const payload = { jsonrpc: "2.0", id };
        if (error) {
            payload.error = error;
        } else {
            payload.result = result;
        }
        sendSseJsonRpc(sessionId, payload);
    };

    // 1. Handle initialize handshake (CRITICAL for clients like Cursor / Claude Desktop)
    if (method === 'initialize') {
        const clientInfo = params?.clientInfo || {};
        // The reported name is cosmetic only — identity comes from the
        // credential, never from anything the client sends here.
        session.clientInfo = clientInfo;
        addLog(auth.clientId, session.clientName, auth.record.deviceId, 'Başlatma', 'success', `Bildirilen istemci: ${String(clientInfo.name || 'bilinmiyor').substring(0, 40)}`);

        reply({
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: {
                tools: {} // We support tools
            },
            serverInfo: {
                name: "mcp-android-bridge",
                version: "1.1.0",
                description: "Android Real Browser MCP Bridge. To view full guide, parameters, and recommended agent workflows, call 'browser_get_tool_documentation'."
            }
        });
        return res.status(200).send("accepted");
    }

    // 2. Handle ping
    if (method === 'ping') {
        reply({});
        return res.status(200).send("accepted");
    }

    // 3. Handle tools list
    if (method === 'tools/list') {
        reply({ tools: TOOLS });
        return res.status(200).send("accepted");
    }

    // 4. Handle tools execution
    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        // deviceId is ignored: the client is bound to exactly one device.
        const cleanArgs = { ...args };
        delete cleanArgs.deviceId;

        // Direct handling for Documentation / Skill Guide Tool (Zero-latency server response)
        if (toolName === "browser_get_tool_documentation" || toolName === "get_tool_documentation" || toolName === "browser_get_skills" || toolName === "get_skills") {
            const toolDocResponse = generateDocumentationResponse(cleanArgs.tool_name || cleanArgs.name, cleanArgs.category);
            addLog(auth.clientId, session.clientName, 'köprü', `Dokümantasyon: ${toolName}`, 'success', String(cleanArgs.tool_name || 'all'));

            const content = [
                {
                    type: "text",
                    text: JSON.stringify(toolDocResponse, null, 2)
                }
            ];
            reply({ content });
            return res.status(200).send("accepted");
        }

        let actionType = "";
        switch (toolName) {
            case "browser_navigate": actionType = "navigate"; break;
            case "browser_search": actionType = "search"; break;
            case "browser_get_html": actionType = "get_html"; break;
            // One markdown tool. The old names still dispatch so a client
            // configured before the rename keeps working.
            case "browser_get_local_markdown":
            case "browser_get_crawl4ai_markdown":
            case "browser_get_markdown": actionType = "get_markdown"; break;
            case "browser_scroll": actionType = "scroll"; break;
            case "browser_click": actionType = "click"; break;
            case "browser_type": actionType = "type"; break;
            case "browser_toggle_overlay": actionType = "toggle_overlay"; break;
            case "browser_execute_js": actionType = "execute_js"; break;
            case "browser_new_tab": actionType = "new_tab"; break;
            case "browser_close_tab": actionType = "close_tab"; break;
            case "browser_list_tabs": actionType = "list_tabs"; break;
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
                return res.status(200).send("accepted");
            default:
                reply(null, { code: -32601, message: `Tool not found: ${toolName}` });
                return res.status(200).send("accepted");
        }

        const clientName = session.clientName || 'AI istemcisi';
        const boundDeviceId = auth.record.deviceId;

        if (!(await enforceQuota(auth, (message) => {
            reply({ isError: true, content: [{ type: 'text', text: message }] });
        }))) {
            addLog(auth.clientId, clientName, boundDeviceId, `Kota aşıldı: ${toolName}`, 'error', 'Günlük komut kotası doldu.');
            return res.status(200).send('accepted');
        }

        try {
            addLog(auth.clientId, clientName, boundDeviceId, `Araç: ${toolName}`, 'pending', '');
            const startedAt = Date.now();
            let responseData = await routeCommandToBrowser(actionType, cleanArgs, auth.clientId, auth.secret);
            responseData = finalizeMarkdownResponse(toolName, responseData);

            // Metadata only: size and host, never the content itself.
            const parts = [`${Date.now() - startedAt} ms`];
            if (typeof responseData.markdown === 'string') parts.push(`${responseData.markdown.length} karakter markdown`);
            if (typeof responseData.html === 'string') parts.push(`${responseData.html.length} karakter html`);
            if (typeof responseData.byte_size === 'number') parts.push(`${Math.round(responseData.byte_size / 1024)} KB görüntü`);
            const host = hostOf(responseData.url);
            if (host) parts.push(host);
            addLog(auth.clientId, clientName, boundDeviceId, `Tamamlandı: ${toolName}`, 'success', parts.join(' · '));

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
                return res.status(200).send("accepted");
            }

            reply({ content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] });
        } catch (error) {
            addLog(auth.clientId, clientName, boundDeviceId, `Hata: ${toolName}`, 'error', error?.name || 'Araç hatası');
            reply({
                isError: true,
                content: [{ type: "text", text: `Hata: ${error.message}` }]
            });
        }
        return res.status(200).send("accepted");
    }

    // Default response for other unhandled methods
    reply({});
    return res.status(200).send("accepted");
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
    const cleanArgs = { ...args };
    delete cleanArgs.deviceId;

    const clientName = auth.record.name;
    const deviceId = auth.record.deviceId;

    let quotaMessage = null;
    if (!(await enforceQuota(auth, (message) => { quotaMessage = message; }))) {
        addLog(auth.clientId, clientName, deviceId, `Kota aşıldı: ${type}`, 'error', 'Günlük komut kotası doldu.');
        return res.status(429).json({ error: 'quota_exceeded', message: quotaMessage });
    }

    try {
        addLog(auth.clientId, clientName, deviceId, `REST: ${type}`, 'pending', '');
        let responseData = await routeCommandToBrowser(type, cleanArgs, auth.clientId, auth.secret);
        responseData = finalizeMarkdownResponse(type, responseData);
        addLog(auth.clientId, clientName, deviceId, `REST tamam: ${type}`, 'success', hostOf(responseData.url));
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
    
    { path: '/mcp/tools/browser_search', type: 'search' },
    { path: '/tools/browser_search', type: 'search' },
    
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
    
    { path: '/mcp/tools/browser_type', type: 'type' },
    { path: '/tools/browser_type', type: 'type' },

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
        deviceId: device.id,
        deviceName: device.name,
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

app.post('/api/v1/logout', async (req, res) => {
    const device = requireDevice(req, res);
    if (!device) return;
    if (!device.accountId) return res.json({ linked: false, deviceId: device.id });

    await store.setDeviceAccount(device.id, null);
    await refreshRegistryCache();
    addLog(null, 'Uygulama', device.id, 'Cihaz Bağı Koparıldı', 'info', 'Kullanıcı uygulamadan çıkış yaptı.');
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
    await store.setAccountPassword(account.id, passwordHash, passwordSalt);
    await store.revokeAccountSessions(account.id);
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

    await store.setDeviceAccount(deviceId, null);
    await refreshRegistryCache();
    addLog(null, 'Panel', deviceId, 'Cihaz Bağı Koparıldı', 'info', 'Cihaz hesaptan ayrıldı.');

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

    // Tell the phone so its own client list matches what the panel just did.
    const ws = browsers.get(record.deviceId);
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'client_revoked', clientId })); } catch (e) {}
    }

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
    await store.setAccountPassword(ctx.account.id, passwordHash, passwordSalt);
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
