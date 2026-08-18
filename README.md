# AI Browser — Köprü Sunucusu

Android tarayıcı uygulamasını MCP istemcilerine (Cursor, Claude Desktop,
Windsurf) bağlayan röle sunucusu ve opsiyonel Crawl4AI markdown servisi.

Android uygulaması ayrı depoda: **AI-Browser-Project-Claude**

## Bu sunucu ne yapar, ne yapmaz

**Yapar:** Bir MCP istemcisinden gelen komutu, o istemcinin eşleştirildiği tek
cihaza yönlendirir. Kimlik bilgisini hash'iyle doğrular, kotayı ve yönlendirmeyi
yönetir.

**Yapmaz:** Kimlik üretmez, izin vermez. Bir komutun *nereye* gideceğine bu
sunucu, *çalışıp çalışmayacağına* telefon karar verir. Yetkilendirme kararı
buraya taşınmamalı — sunucu ele geçirilse bile kimsenin oturum açmış tarayıcısı
sürülememeli.

## Deploy (Render)

1. Render Dashboard → **New → Blueprint** → bu depoyu seç.
2. `render.yaml` iki servis tanımlar: `ai-browser-bridge` (Node) ve
   `ai-browser-crawl4ai` (Docker). Crawl4AI'a ihtiyacın yoksa ikinci servisi
   Blueprint ekranından atlayabilirsin.
3. Deploy bitince Environment sekmesinden `ADMIN_TOKEN` değerini oku — operatör
   konsoluna `/` adresinden bu değerle girersin.
4. Crawl4AI'ı da kurduysan, köprü servisine şunları gir:
   - `CRAWL4AI_API_URL` → `https://<crawl4ai-servisi>.onrender.com/crawl`
   - `CRAWL4AI_API_TOKEN` → crawl4ai servisinin ürettiği değerle aynı
5. Android uygulamasında **Ayarlar → MCP** ekranına köprü adresini gir.

### Dikkat: tek instance

Bağlı cihazlar, eşleştirilmiş istemciler ve açık MCP oturumları bellekte
tutuluyor. Birden fazla instance çalışırsa cihazın WebSocket'i bir instance'a,
araç çağrıları başkasına düşer ve köprü sessizce bozulur. `numInstances: 1`
olarak bırak.

### Dikkat: durum kalıcılığı

Ücretsiz planda dosya sistemi her deploy'da sıfırlanır, yani cihaz/istemci
kayıt defteri silinir. Sistem kendini onarır (telefon yeniden bağlandığında
istemci listesini yeniden bildirir), ama arada kalan pencerede cihaz kimliği
koruması sıfırlanır. Kalıcı hale getirmek için `render.yaml` içindeki `disk`
bloğunu ve `BRIDGE_STATE_FILE` değişkenini aç, planı `starter`'a çek.

## Yerel çalıştırma

```bash
npm install
cp .env.example .env   # ADMIN_TOKEN doldur
npm start
```

`.env` dosyası açılışta otomatik okunur (Node 20.12+ yerleşik desteği). Token
üretmek için:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Uçlar

| Uç | Kimlik | Ne yapar |
| --- | --- | --- |
| `GET /sse` | İstemci | MCP SSE kanalı |
| `POST /message` | İstemci | JSON-RPC araç çağrıları |
| `GET /healthz` | Yok | Sağlık kontrolü |
| `GET /` | ADMIN_TOKEN | Operatör konsolu |
| `GET /api/status` | ADMIN_TOKEN | Cihazlar, istemciler, son işlemler |
| WebSocket `/` | deviceSecret | Android cihaz bağlantısı |

## Kimlik doğrulama

MCP istemcileri `Authorization: Bearer <clientId>.<secret>` gönderir.

Bu değeri **telefon** üretir: kullanıcı uygulamada *Ayarlar → Oturumlar → AI
istemcisi ekle* der, cihaz anahtarı oluşturur ve gösterir, kullanıcı kopyalayıp
MCP yapılandırmasına yapıştırır. Anahtar kalıcıdır ve istemci kartından
istenildiği zaman tekrar kopyalanabilir; sızma şüphesinde aynı karttan
yenilenir (kimlik, çerez profili ve izinler korunur, yalnızca sır değişir).

Telefon röleye **yalnızca `sha256(secret)`** bildirir — `client_added` mesajıyla,
ayrıca her yeniden bağlanmada tüm listeyi yayınlar. Röle yalnızca hash'i ve
`clientId → deviceId` bağını tutar; **düz metin sır röleye hiçbir zaman
yazılmaz.** Düz metni yalnızca telefon, kendi uygulamasına özel deposunda tutar
(anahtarın tekrar kopyalanabilmesi için bilinçli bir tercih).

Rastgele veya uydurma bir token ile bağlanmak mümkün değildir: `clientId`
kayıtlı değilse istek 401 döner, kayıtlıysa da telefon sırrı kendi defterine
karşı ayrıca doğrular.

## Onay ve engeller (cihaz tarafı)

Röle bu kararların hiçbirini vermez, ama araç yanıtlarında karşılığını görürsün:

- **Anlık onay.** Oturum verisi silme, JavaScript çalıştırma ve kişisel bilgi
  alanlarını doldurma telefonda kullanıcı onayı ister; 30 saniyede yanıt yoksa
  reddedilir. Şifre ve ödeme alanları ayrı bir izne (`sensitive_fields`,
  varsayılan kapalı) bağlıdır.
- **Devralma.** Kullanıcı bir sekmeyi devralırsa o sekmede okuma dahil hiçbir
  komut çalışmaz; ajanın `browser_new_tab` ile başka sekmeye geçmesi gerekir.
- **Boş sekme.** Ana sayfaya dönmüş bir sekmede sayfa araçları, ne yapılması
  gerektiğini anlatan bir metin döndürür.
- **Ekran görüntüsü.** Android yalnızca ekranda olan bir WebView'ı çizer. Arka
  plandaki bir sekme için cihaz, uygulama telefonda açıksa sekmeyi bir anlığına
  ekrana alıp görüntüyü çeker ve ekranı eski haline döndürür; uygulama ön planda
  değilse `blank_capture` döner. Röle bu yanıtı yalnızca taşır.

## Deploy sonrası

Sunucu `SIGTERM`/`SIGINT` aldığında durumu diske yazar, MCP oturumlarını
kapatır ve telefonlara 1001 ("going away") gönderir; telefon bunu arıza değil
yeniden başlatma sayar ve normal backoff'uyla hemen bağlanır.

## Loglar

Operatör konsolu yalnızca meta veri gösterir: araç adı, süre, alan adı, sonuç.
Sayfa içeriği, tam URL ve kimlik bilgisi hiçbir zaman loglanmaz — bu köprü
oturum açılmış tarayıcı trafiği taşıyor ve log en kolay sızan şey.

## Bilinen sınırlar

- Tek instance zorunlu (yukarıya bakın)
- Rölede hız sınırı yok. Eşzamanlılık sınırı **cihazda**: bir istemci aynı anda
  en fazla 3 komut çalıştırabilir, dördüncü `too_many_requests` ile reddedilir.
  Bir komutun gerçekten bittiğini yalnızca telefon bildiği için bu karar orada.
- Ücretsiz planda servis hareketsizlikte uykuya geçer; uygulama otomatik
  yeniden bağlanır ama ilk komutta soğuk başlangıç gecikmesi olur
