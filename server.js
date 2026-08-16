const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID, createHash, timingSafeEqual } = require('crypto');
const fs = require('fs');
const path = require('path');

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

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const STATE_FILE = process.env.BRIDGE_STATE_FILE || path.join(__dirname, '.bridge-state.json');
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
// The device is the authority: it mints every clientId/clientSecret and tells
// us only the hash. We keep the hash so we can reject bad credentials early,
// and the clientId -> deviceId binding so a command can never be routed to
// somebody else's phone.
// ----------------------------------------------------
const devices = new Map(); // deviceId -> { secretHash }
const clients = new Map(); // clientId -> { deviceId, secretHash, name }

function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function safeEquals(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return timingSafeEqual(bufA, bufB);
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        Object.entries(raw.devices || {}).forEach(([id, v]) => devices.set(id, v));
        Object.entries(raw.clients || {}).forEach(([id, v]) => clients.set(id, v));
        console.log(`[State] Restored ${devices.size} device(s), ${clients.size} client(s).`);
    } catch (e) {
        console.error('[State] Could not read state file:', e.message);
    }
}

let saveTimer = null;
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify({
                devices: Object.fromEntries(devices),
                clients: Object.fromEntries(clients)
            }), 'utf8');
        } catch (e) {
            console.error('[State] Could not persist state file:', e.message);
        }
    }, 250);
}
loadState();

// ----------------------------------------------------
// LOGGING — metadata only.
// Never record tokens, page content, or full URLs here: this bridge carries
// authenticated browsing sessions and the log is the easiest thing to leak.
// ----------------------------------------------------
const logs = [];
function hostOf(url) {
    try { return new URL(String(url)).host; } catch (e) { return ''; }
}
function addLog(clientId, clientName, deviceId, action, status, detail) {
    logs.unshift({
        id: randomUUID().substring(0, 8),
        timestamp: new Date().toLocaleTimeString('tr-TR'),
        clientId: clientId ? String(clientId).substring(0, 12) : 'N/A',
        clientName: clientName || 'N/A',
        deviceId: deviceId || 'N/A',
        action,
        status, // 'success', 'error', 'pending', 'info'
        detail: detail || ''
    });
    if (logs.length > 100) logs.pop();
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
        name: "browser_get_local_markdown",
        description: "Şu an açık olan sayfanın yerel dahili dönüştürücüsü (Built-in Turndown JS Engine) ile dönüştürülmüş Markdown içeriğini (`markdown`) alır. Crawl4AI sunucusuna istek atmadan doğrudan yerel ve hızlı dönüşüm yapar.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: { type: "string", description: "Hedef cihaz ID'si (opsiyonel)" }
            }
        }
    },
    {
        name: "browser_get_markdown",
        description: "Şu an açık olan sayfanın resmi Python Crawl4AI motoru ile işlenmiş fit_markdown/Markdown içeriğini (`markdown`), kullanılan motor bilgisini (`engine_used`) ve dönüştürme durumunu (`markdown_status`) alır.",
        inputSchema: {
            type: "object",
            properties: {
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
        description: "Tüm aktif oturumları listeler. Eğer kullanıcı ayarlarında oturumlar arası erişim kapalı ise yalnızca mevcut AI oturumu döner.",
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
            "Crawl4AI & Dahili Turndown Markdown Motorları ile anında temiz içerik çıkarma",
            "Vimium-Style Numaralandırılmış Görsel Overlay ile elementleri ID sayılarıyla seçme/tıklama",
            "Çoklu Sekme (Multi-Tab) yönetimi ve DOM kaynağı alma"
        ],
        security_note: "Her istemci cihaz tarafından üretilen kalıcı bir kimliğe ve kendi izole çerez profiline sabitlenmiştir. Profil veya oturum değiştirilemez. 'execute_js' ve 'clear_data' yetkileri varsayılan olarak kapalıdır; kullanıcı telefondan açmadıkça bu çağrılar reddedilir. Sahip olduğunuz izinleri 'browser_get_session_info' ile görebilirsiniz.",
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
            tools: ["browser_get_markdown", "browser_get_local_markdown", "browser_get_html"]
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
            best_practice: "Gezinti sonrası içerik okumak için 'browser_get_local_markdown' veya 'browser_get_markdown' aracını çağırın."
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
            best_practice: "Google aramasından sonra arama sonuçlarındaki linkleri ve başlıkları okumak için 'browser_get_local_markdown' çağırın."
        },
        browser_get_local_markdown: {
            name: "browser_get_local_markdown",
            category: "content_extraction",
            summary: "Açık olan sayfanın yerel dahili Turndown motoruyla anında dönüştürülmüş Markdown içeriğini döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "En hızlı, en hafif ve sıfır gecikmeli içerik okuma aracıdır. Makale okumak, arama sonuçlarını taramak veya sayfa yapısını anlamak için ilk tercihiniz olmalıdır."
        },
        browser_get_markdown: {
            name: "browser_get_markdown",
            category: "content_extraction",
            summary: "Sayfanın resmi Crawl4AI Python motoru ile işlenmiş fit_markdown içeriğini döner.",
            parameters: {
                deviceId: "(Opsiyonel, String) Hedef Android cihaz ID'si."
            },
            best_practice: "Crawl4AI sunucusu aktif olduğunda gereksiz gürültüden arındırılmış temiz metin çıktısı sağlar."
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
        browser_toggle_overlay: {
            name: "browser_toggle_overlay",
            category: "interaction",
            summary: "Ekrandaki tüm interaktif elementlerin üzerine Vimium-style görsel numaralandırma etiketleri ekler/kaldırır.",
            parameters: {
                enabled: "(Zorunlu, Boolean) true (etiketleri aç) veya false (kapat)"
            },
            best_practice: "Form doldururken veya karmaşık bir sayfada tıklama yaparken önce overlay'i açın, ardından 'browser_get_local_markdown' çıktısındaki element ID sayılarını tespit edip doğrudan ID numarasıyla ('1', '2' vb.) tıklayın."
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
            best_practice: "Yazı yazdıktan sonra formu göndermek için ilgili butona 'browser_click' yapın veya 'browser_execute_js' ile form.submit() tetikleyin."
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
            best_practice: "Özel DOM sorguları, çerez okuma, sayfa içi hesaplamalar veya karmaşık tetikleyiciler için kullanın."
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
            summary: "Kendi oturumunuzun kimliğini, adını, açık sekme sayısını ve cihazın size verdiği izinleri döner.",
            parameters: {},
            best_practice: "Bir işe başlamadan önce hangi izinlere sahip olduğunuzu buradan doğrulayın; kapalı bir yetkiyi çağırmak yerine kullanıcıdan telefondan açmasını isteyin."
        },
        browser_list_sessions: {
            name: "browser_list_sessions",
            category: "tabs_and_sessions",
            summary: "Yalnızca kendi oturumunuzu döner. Oturumlar arası görünürlük cihaz tarafından kapatılmıştır.",
            parameters: {},
            best_practice: "Profil seçimi cihazın kararıdır; başka bir oturuma geçiş yapılamaz."
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
            best_practice: "'clear_data' izni varsayılan olarak kapalıdır. Yalnızca kendi profilinize uygulanır; başka bir oturumun verisi silinemez."
        }
    },
    playbooks: [
        {
            title: "İş Akışı 1: Web Araması ve Bilgi Toplama (Research & Extract)",
            steps: [
                "1. 'browser_search(query: \"...\")' çağırarak arama yapın.",
                "2. 'browser_get_local_markdown()' çağırarak arama sonuçlarını ve linkleri okuyun.",
                "3. İlgili bir sonuca gitmek için 'browser_navigate(url: \"...\")' veya 'browser_click(selector: \"text=...\")' çağırın.",
                "4. Hedef sayfadaki tam içeriği 'browser_get_local_markdown()' ile çekip kullanıcıya özetleyin."
            ]
        },
        {
            title: "İş Akışı 2: Form Doldurma ve Buton Tıklama (Form Filling & Automation)",
            steps: [
                "1. 'browser_navigate(url: \"...\")' ile sayfayı açın.",
                "2. 'browser_type(selector: \"input[name='username']\", text: \"...\")' ile inputları doldurun.",
                "3. Butona tıklamak için 'browser_click(selector: \"text=Giriş Yap\")' veya CSS seçici kullanın.",
                "4. İşlemin sonucunu doğrulamak için 'browser_get_local_markdown()' çağırın."
            ]
        },
        {
            title: "İş Akışı 3: Numaralandırılmış Element ile Hassas Tıklama",
            steps: [
                "1. 'browser_toggle_overlay(enabled: true)' ile interaktif elementlerin üzerine numaralandırma etiketlerini yerleştirin.",
                "2. 'browser_get_local_markdown()' çağırarak çıktının başındaki 'İnteraktif Elementler Tablosu'ndan ID numaralarını okuyun.",
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
    if (!raw) raw = req.query.token || req.headers['x-mcp-token'] || '';
    return parseCredential(raw);
}

// Returns { ok, clientId, secret, record } or { ok:false, reason }
function authenticate(req) {
    const cred = extractCredential(req);
    if (!cred) return { ok: false, reason: 'missing' };
    const record = clients.get(cred.clientId);
    if (!record) return { ok: false, reason: 'unknown' };
    if (!safeEquals(sha256(cred.secret), record.secretHash)) return { ok: false, reason: 'bad_secret' };
    return { ok: true, clientId: cred.clientId, secret: cred.secret, record };
}

function requireAuth(req, res) {
    const auth = authenticate(req);
    if (auth.ok) return auth;
    res.status(401).json({
        error: 'unauthorized',
        message: "Geçerli bir istemci kimliği gerekli. Android uygulamasında Ayarlar → MCP → 'AI istemcisi ekle' ile bir eşleştirme kodu alın ve verilen 'Authorization: Bearer <clientId>.<secret>' başlığını MCP yapılandırmanıza ekleyin."
    });
    return null;
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

    ws.on('message', (message) => {
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
            } else {
                // Trust on first use: the first device to claim this id owns it.
                devices.set(id, { secretHash: sha256(secret) });
                console.log(`[WS] New device enrolled: ${id}`);
            }

            deviceId = id;
            authenticated = true;
            clearTimeout(authDeadline);

            // The device is the authority on which clients exist. Rebuild its
            // slice of the registry from what it just told us.
            if (Array.isArray(payload.clients)) {
                for (const [cid, rec] of clients.entries()) {
                    if (rec.deviceId === id) clients.delete(cid);
                }
                payload.clients.forEach((c) => {
                    const cid = String(c.clientId || '').trim();
                    const hash = String(c.secretHash || '').trim();
                    if (cid && /^[a-f0-9]{64}$/i.test(hash)) {
                        clients.set(cid, { deviceId: id, secretHash: hash, name: String(c.name || 'AI istemcisi').substring(0, 60) });
                    }
                });
            }
            saveState();

            const existing = browsers.get(id);
            if (existing && existing !== ws) {
                try { existing.close(1000, 'Yeni bağlantı ile değiştirildi'); } catch (e) {}
            }
            browsers.set(id, ws);

            addLog(null, 'Android Uygulaması', id, 'Cihaz Bağlandı', 'success', `${clients.size} eşleştirilmiş istemci bildirildi.`);
            ws.send(JSON.stringify({ type: 'register_ack', deviceId: id, status: 'success' }));
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
            clients.set(cid, {
                deviceId,
                secretHash: hash,
                name: String(payload.name || 'AI istemcisi').substring(0, 60)
            });
            saveState();
            addLog(cid, payload.name, deviceId, 'İstemci Eklendi', 'success', 'Cihaz yeni bir erişim anahtarı üretti.');
            return;
        }

        if (payload.type === 'revoke_client') {
            const cid = String(payload.clientId || '').trim();
            const rec = clients.get(cid);
            if (rec && rec.deviceId === deviceId) {
                clients.delete(cid);
                saveState();
                addLog(cid, rec.name, deviceId, 'İstemci İptal Edildi', 'info', 'Kullanıcı erişimi kaldırdı.');
            }
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
        console.log(`[SSE] Sending JSON-RPC response to session ${sessionId}:`, JSON.stringify(jsonRpcMessage));
        res.write(`event: message\ndata: ${JSON.stringify(jsonRpcMessage)}\n\n`);
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

    sseSessions.set(sessionId, {
        res,
        clientId: auth.clientId,
        secret: auth.secret,
        clientName: auth.record.name,
        clientInfo: { name: auth.record.name }
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
            case "browser_get_local_markdown": actionType = "get_local_markdown"; break;
            case "browser_get_markdown": 
            case "browser_get_crawl4ai_markdown": actionType = "get_markdown"; break;
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
            case "browser_screenshot":
                reply({
                    isError: true,
                    content: [{ type: "text", text: "browser_screenshot şu an desteklenmiyor. Sayfa durumunu görmek için 'browser_get_local_markdown' kullanın." }]
                });
                return res.status(200).send("accepted");
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

        try {
            addLog(auth.clientId, clientName, boundDeviceId, `Araç: ${toolName}`, 'pending', '');
            const startedAt = Date.now();
            let responseData = await routeCommandToBrowser(actionType, cleanArgs, auth.clientId, auth.secret);
            responseData = await processCrawl4AIEngine(toolName, responseData, auth.clientId, clientName, boundDeviceId);

            // Metadata only: size and host, never the content itself.
            const parts = [`${Date.now() - startedAt} ms`];
            if (typeof responseData.markdown === 'string') parts.push(`${responseData.markdown.length} karakter markdown`);
            if (typeof responseData.html === 'string') parts.push(`${responseData.html.length} karakter html`);
            const host = hostOf(responseData.url);
            if (host) parts.push(host);
            addLog(auth.clientId, clientName, boundDeviceId, `Tamamlandı: ${toolName}`, 'success', parts.join(' · '));

            reply({ content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }] });
        } catch (error) {
            addLog(auth.clientId, clientName, boundDeviceId, `Hata: ${toolName}`, 'error', String(error.message).substring(0, 160));
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

function extractMarkdownFromCrawlResponse(obj) {
    if (!obj) return null;
    
    if (typeof obj === 'string') {
        const trimmed = obj.trim();
        if (trimmed && trimmed !== "None" && !trimmed.startsWith('<!DOCTYPE') && !trimmed.startsWith('<html')) {
            return trimmed;
        }
        return null;
    }

    if (typeof obj !== 'object') return null;

    // 1. Direct priority keys
    const priorityKeys = ['fit_markdown', 'markdown', 'raw_markdown', 'citations_markdown', 'content_markdown'];
    for (const key of priorityKeys) {
        if (obj[key]) {
            const sub = extractMarkdownFromCrawlResponse(obj[key]);
            if (sub) return sub;
        }
    }

    // 2. Look inside 'results', 'result', 'data', 'items' arrays or objects
    const containers = ['results', 'result', 'data', 'items'];
    for (const containerKey of containers) {
        const val = obj[containerKey];
        if (Array.isArray(val) && val.length > 0) {
            for (const item of val) {
                const sub = extractMarkdownFromCrawlResponse(item);
                if (sub) return sub;
            }
        } else if (val && typeof val === 'object') {
            const sub = extractMarkdownFromCrawlResponse(val);
            if (sub) return sub;
        } else if (typeof val === 'string') {
            const sub = extractMarkdownFromCrawlResponse(val);
            if (sub) return sub;
        }
    }

    // 3. Look at generic string keys
    const textKeys = ['content', 'text', 'cleaned_html', 'md'];
    for (const key of textKeys) {
        if (obj[key]) {
            const sub = extractMarkdownFromCrawlResponse(obj[key]);
            if (sub) return sub;
        }
    }

    return null;
}

async function processCrawl4AIEngine(toolName, responseData, clientId = null, clientName = null, deviceId = null) {
    if (!responseData) return responseData;

    // Capture initial fallback markdown from Android local JS engine
    const fallbackMarkdown = responseData.markdown || responseData.turndown_markdown || responseData.custom_markdown || "";

    // 1. LOCAL MARKDOWN TOOL (browser_get_local_markdown)
    if (toolName === "browser_get_local_markdown" || toolName === "get_local_markdown") {
        responseData.markdown = fallbackMarkdown;
        responseData.engine_used = "Built-in Turndown JS Engine (Local)";
        responseData.markdown_status = "SUCCESS (Built-in Turndown JS Engine)";

        delete responseData.turndown_markdown;
        delete responseData.custom_markdown;
        delete responseData.crawl4ai_markdown;
        delete responseData.fit_markdown;
        delete responseData.raw_markdown;
        delete responseData.html;
        delete responseData.raw_html;

        return responseData;
    }

    // 2. HTML TOOL (browser_get_html)
    if (toolName === "browser_get_html" || toolName === "get_html") {
        responseData.markdown = fallbackMarkdown;
        responseData.engine_used = "Built-in Turndown JS Engine (Local)";
        delete responseData.turndown_markdown;
        delete responseData.custom_markdown;
        delete responseData.crawl4ai_markdown;
        delete responseData.fit_markdown;
        delete responseData.raw_markdown;
        delete responseData.raw_html;

        return responseData;
    }

    // 3. CRAWL4AI MARKDOWN TOOL (browser_get_markdown / browser_get_crawl4ai_markdown)
    const isCrawlTool = (toolName === "browser_get_markdown" || toolName === "browser_get_crawl4ai_markdown" || toolName === "get_markdown");

    let crawlError = null;
    let convertedMarkdown = null;

    const targetUrl = (process.env.CRAWL4AI_API_URL || '').trim();

    if (isCrawlTool) {
        if (!targetUrl) {
            console.log(`[Crawl4AI] CRAWL4AI_API_URL is NOT configured in environment. Using local Turndown JS fallback engine.`);
        } else if (responseData.html || responseData.raw_html || responseData.url) {
            try {
                const fullRawHtml = responseData.raw_html || responseData.html || '';
                
                // Only our own configured token. The MCP client's Authorization
                // header must never be forwarded to a third-party service.
                const rawToken = process.env.CRAWL4AI_API_TOKEN || process.env.CRAWL4AI_TOKEN || '';

                let cleanToken = "";
                if (rawToken) {
                    cleanToken = String(rawToken).trim().replace(/^Bearer\s+/i, '');
                }

                const maskedToken = cleanToken ? `${cleanToken.substring(0, 4)}***` : 'NONE';
                console.log(`[Crawl4AI] Initiating Crawl4AI Engine Request:
  -> URL: ${targetUrl}
  -> Page HTML Length: ${fullRawHtml.length} chars
  -> Page URL: ${responseData.url || 'N/A'}
  -> Auth Token: ${maskedToken}`);

                addLog(clientId, clientName, deviceId, 'Crawl4AI İsteği', 'info', `${fullRawHtml.length} karakter HTML gönderiliyor.`);

                const crawlHeaders = { 
                    'Content-Type': 'application/json',
                    'Bypass-Tunnel-Reminder': 'true',
                    'User-Agent': 'MCP-Server/1.0'
                };

                if (cleanToken) {
                    crawlHeaders['Authorization'] = `Bearer ${cleanToken}`;
                    crawlHeaders['X-API-Key'] = cleanToken;
                }

                const pageUrl = (responseData.url && typeof responseData.url === 'string' && responseData.url.trim().length > 0)
                    ? responseData.url.trim()
                    : 'https://browser.page';

                const requestBody = {
                    urls: [pageUrl],
                    url: pageUrl,
                    html: fullRawHtml,
                    raw_html: fullRawHtml,
                    word_count_threshold: 10,
                    api_key: cleanToken,
                    token: cleanToken
                };

                const crawlRes = await fetch(targetUrl, {
                    method: 'POST',
                    headers: crawlHeaders,
                    signal: AbortSignal.timeout(20000), // 20 seconds timeout
                    body: JSON.stringify(requestBody)
                });

                console.log(`[Crawl4AI] HTTP Response Received: Status ${crawlRes.status} ${crawlRes.statusText}`);

                if (crawlRes.ok) {
                    const crawlJson = await crawlRes.json();
                    const authenticMarkdown = extractMarkdownFromCrawlResponse(crawlJson);
                    
                    if (authenticMarkdown && authenticMarkdown.length > 0) {
                        console.log(`[Crawl4AI] SUCCESS: Received official Crawl4AI markdown (${authenticMarkdown.length} chars)!`);
                        convertedMarkdown = authenticMarkdown;
                        responseData.engine_used = "Official Crawl4AI Python Engine";
                        responseData.markdown_status = "SUCCESS (Official Crawl4AI Python Engine)";
                        addLog(clientId, clientName, deviceId, 'Crawl4AI Başarılı', 'success', `${authenticMarkdown.length} karakter markdown üretildi.`);
                    } else {
                        console.warn('[Crawl4AI] WARNING: Could not parse markdown from response body.');
                        crawlError = 'Crawl4AI yanıt biçimi tanınmadı.';
                        addLog(clientId, clientName, deviceId, 'Crawl4AI Format Hatası', 'error', 'Yanıt 200 döndü ancak markdown çıkarılamadı.');
                    }
                } else {
                    console.error(`[Crawl4AI] ERROR: Service returned HTTP ${crawlRes.status}`);
                    crawlError = `HTTP ${crawlRes.status}`;
                    addLog(clientId, clientName, deviceId, 'Crawl4AI Hatası', 'error', `HTTP ${crawlRes.status}`);
                }
            } catch (c4err) {
                console.error(`[Crawl4AI] EXCEPTION: ${c4err.message}`);
                crawlError = `Exception: ${c4err.message}`;
                addLog(clientId, clientName, deviceId, 'Crawl4AI Bağlantı Hatası', 'error', String(c4err.message).substring(0, 120));
            }
        }
    }

    // Set single primary markdown field & status information
    if (convertedMarkdown) {
        responseData.markdown = convertedMarkdown;
    } else {
        if (isCrawlTool) {
            /* 
            // YEDEK/FALLBACK MEKANİZMASI (Pasife alındı)
            responseData.markdown = fallbackMarkdown;
            responseData.engine_used = "Built-in Turndown JS Engine (Local Fallback)";
            if (crawlError) {
                responseData.markdown_status = `FALLBACK: Built-in Turndown JS Engine (Crawl4AI Error: ${crawlError})`;
            } else if (!targetUrl) {
                responseData.markdown_status = "FALLBACK: Built-in Turndown JS Engine (CRAWL4AI_API_URL not set in Render environment)";
            } else {
                responseData.markdown_status = "FALLBACK: Built-in Turndown JS Engine (Crawl4AI returned empty response)";
            }
            */
            responseData.markdown = `Crawl4AI bağlantı başarısız oldu veya dönüşüm yapılamadı.\n\nHata detayı: ${crawlError || 'CRAWL4AI_API_URL eksik veya geçersiz.'}\n\nLütfen yerel çevirimi kullanmak için 'browser_get_local_markdown' aracını çağırın.`;
            responseData.engine_used = "Crawl4AI Python Engine (FAILED)";
            responseData.markdown_status = "FAILED";
        } else {
            responseData.markdown = fallbackMarkdown;
        }
    }

    // CLEANUP: Remove duplicate and redundant fields to avoid confusion for AI client
    delete responseData.turndown_markdown;
    delete responseData.custom_markdown;
    delete responseData.crawl4ai_markdown;
    delete responseData.fit_markdown;
    delete responseData.raw_markdown;
    delete responseData.raw_html;

    if (isCrawlTool) {
        delete responseData.html;
    }

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

    try {
        addLog(auth.clientId, clientName, deviceId, `REST: ${type}`, 'pending', '');
        let responseData = await routeCommandToBrowser(type, cleanArgs, auth.clientId, auth.secret);
        responseData = await processCrawl4AIEngine(type, responseData, auth.clientId, clientName, deviceId);
        addLog(auth.clientId, clientName, deviceId, `REST tamam: ${type}`, 'success', hostOf(responseData.url));
        return res.json({ status: "success", data: responseData });
    } catch (error) {
        addLog(auth.clientId, clientName, deviceId, `REST hata: ${type}`, 'error', String(error.message).substring(0, 160));
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
    
    { path: '/mcp/tools/browser_get_local_markdown', type: 'get_local_markdown' },
    { path: '/tools/browser_get_local_markdown', type: 'get_local_markdown' },
    
    { path: '/mcp/tools/browser_get_markdown', type: 'get_markdown' },
    { path: '/tools/browser_get_markdown', type: 'get_markdown' },
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

// Operator status endpoint. Requires ADMIN_TOKEN; without one configured the
// endpoint stays closed rather than defaulting to public.
app.get('/api/status', (req, res) => {
    if (!ADMIN_TOKEN) {
        return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_TOKEN ortam değişkeni tanımlı değil; izleme paneli kapalı.' });
    }
    const header = req.headers['authorization'] || '';
    const provided = header.toLowerCase().startsWith('bearer ') ? header.substring(7).trim() : (req.headers['x-admin-token'] || '');
    if (!safeEquals(provided, ADMIN_TOKEN)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({
        status: "running",
        connected_devices: Array.from(browsers.keys()),
        paired_clients: Array.from(clients.entries()).map(([id, c]) => ({ id, name: c.name, deviceId: c.deviceId })),
        active_sessions: sseSessions.size,
        logs
    });
});

// ----------------------------------------------------
// OPERATOR CONSOLE
// Everything here renders through the DOM API, never innerHTML: log rows carry
// client-supplied names and device ids, and this page is opened by the person
// who can least afford to run somebody else's script.
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP Köprü Konsolu</title>
<style>
  :root{--bg:#0b1120;--card:#141d2b;--line:#25303f;--text:#e7eaee;--muted:#8b97a5;--accent:#d3ab68;--ok:#7fb88c;--err:#e97c6e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:32px 20px 64px;display:flex;flex-direction:column;gap:20px}
  h1{font:600 20px/1.2 ui-monospace,Consolas,monospace;margin:0}
  .sub{color:var(--muted);font-size:13px;margin:0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:12px}
  h2{font:600 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0}
  input{background:#0b1120;border:1px solid var(--line);border-radius:6px;color:var(--text);padding:9px 12px;font:13px ui-monospace,Consolas,monospace;flex:1;min-width:0}
  button{background:var(--accent);color:#141d2b;border:0;border-radius:6px;padding:9px 16px;font-weight:600;cursor:pointer}
  button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .stat{background:#0b1120;border:1px solid var(--line);border-radius:6px;padding:12px}
  .stat .n{font:700 26px/1.1 ui-monospace,Consolas,monospace}
  .stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
  ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  li{background:#0b1120;border:1px solid var(--line);border-radius:6px;padding:8px 12px;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
  .log{display:flex;flex-direction:column;gap:2px}
  .log .top{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--muted)}
  .log .act{font-size:12px;color:var(--text)}
  .log .det{font-size:11px;color:var(--muted)}
  .s-success{color:var(--ok)} .s-error{color:var(--err)} .s-pending{color:var(--accent)}
  .empty{color:var(--muted);font-style:italic;font-size:12px}
  code{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1>MCP Köprü Konsolu</h1>
    <p class="sub">Bu köprü kimlik doğrulaması gerektirir. AI istemcileri Android uygulamasından alınan eşleştirme kodu ile bağlanır.</p>
  </div>

  <div class="card">
    <h2>Operatör Girişi</h2>
    <div class="row">
      <input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
      <button id="go">Bağlan</button>
    </div>
    <p class="sub" id="msg"></p>
  </div>

  <div class="card" id="panel" hidden>
    <h2>Durum</h2>
    <div class="grid">
      <div class="stat"><div class="n" id="c-dev">0</div><div class="l">Bağlı Cihaz</div></div>
      <div class="stat"><div class="n" id="c-cli">0</div><div class="l">Eşleşmiş İstemci</div></div>
      <div class="stat"><div class="n" id="c-ses">0</div><div class="l">Açık Oturum</div></div>
    </div>
    <h2>Cihazlar</h2>
    <ul id="devs"></ul>
    <h2>İstemciler</h2>
    <ul id="clis"></ul>
    <h2>Son İşlemler</h2>
    <ul id="logs"></ul>
  </div>

  <div class="card">
    <h2>İstemci Kurulumu</h2>
    <p class="sub">1 · Android uygulamasında <b>Ayarlar → Oturumlar → AI istemcisi ekle</b> ile bir erişim anahtarı üretin.</p>
    <p class="sub">2 · Anahtarı kopyalayın — yalnızca üretildiği anda görünür, cihaz sadece özetini saklar.</p>
    <p class="sub">3 · MCP istemcinizde <code>Authorization: Bearer &lt;clientId&gt;.&lt;secret&gt;</code> olarak tanımlayın; SSE adresi <code id="sse"></code>.</p>
  </div>
</div>

<script>
  document.getElementById('sse').textContent = location.origin + '/sse';

  var token = sessionStorage.getItem('mcp_admin') || '';
  var timer = null;

  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function fill(listId, items, render){
    var ul = document.getElementById(listId);
    ul.replaceChildren();
    if (!items || items.length === 0){
      ul.appendChild(el('li', 'empty', 'Kayıt yok.'));
      return;
    }
    items.forEach(function(item){ ul.appendChild(render(item)); });
  }

  function renderLog(log){
    var li = el('li', 'log');
    var top = el('div', 'top');
    top.appendChild(el('span', null, log.timestamp));
    top.appendChild(el('span', 's-' + log.status, '[' + String(log.status).toUpperCase() + ']'));
    top.appendChild(el('span', null, log.clientName));
    top.appendChild(el('span', null, '→ ' + log.deviceId));
    li.appendChild(top);
    li.appendChild(el('div', 'act', log.action));
    if (log.detail) li.appendChild(el('div', 'det', log.detail));
    return li;
  }

  async function refresh(){
    try{
      var r = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
      if (r.status === 401){ stop('Token geçersiz.'); return; }
      if (r.status === 503){ stop('Sunucuda ADMIN_TOKEN tanımlı değil.'); return; }
      if (!r.ok){ return; }
      var d = await r.json();
      document.getElementById('panel').hidden = false;
      document.getElementById('msg').textContent = '';
      document.getElementById('c-dev').textContent = d.connected_devices.length;
      document.getElementById('c-cli').textContent = d.paired_clients.length;
      document.getElementById('c-ses').textContent = d.active_sessions;
      fill('devs', d.connected_devices, function(id){ return el('li', null, id); });
      fill('clis', d.paired_clients, function(c){ return el('li', null, c.name + '  ·  ' + c.id + '  ·  ' + c.deviceId); });
      fill('logs', d.logs, renderLog);
    }catch(e){ /* transient network error, next tick retries */ }
  }

  function stop(message){
    clearInterval(timer); timer = null;
    sessionStorage.removeItem('mcp_admin');
    document.getElementById('panel').hidden = true;
    document.getElementById('msg').textContent = message;
  }

  function start(){
    token = document.getElementById('tok').value.trim() || token;
    if (!token){ document.getElementById('msg').textContent = 'Token girin.'; return; }
    sessionStorage.setItem('mcp_admin', token);
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 3000);
  }

  document.getElementById('go').addEventListener('click', start);
  document.getElementById('tok').addEventListener('keydown', function(e){ if (e.key === 'Enter') start(); });
  if (token) start();
</script>
</body>
</html>`);
});

// Health check that reveals nothing.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// NOTE: The previous build exposed /oauth/authorize, /oauth/token and
// /oauth/register. They auto-approved every request, handed out one static
// access token that was never checked, and redirected to an unvalidated
// redirect_uri. They have been removed rather than patched: they provided the
// appearance of authorization while granting none. A credential can now only
// be minted on the device itself, which announces the hash over its WebSocket.

// Start listening
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log('=================================================');
    console.log(` MCP Bridge Server listening on port ${PORT}`);
    console.log(` - Console:  http://localhost:${PORT}/`);
    console.log(` - MCP SSE:  http://localhost:${PORT}/sse   (kimlik doğrulaması gerekli)`);
    console.log(``);
    console.log(` - Enrolled: ${devices.size} cihaz, ${clients.size} istemci`);
    if (!ADMIN_TOKEN) {
        console.warn(' ! ADMIN_TOKEN tanımlı değil — operatör konsolu kapalı.');
    }
    console.log('=================================================');
});
