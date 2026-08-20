# AI Browser — Köprü Sunucusu

Android tarayıcı uygulamasını MCP istemcilerine (Cursor, Claude Desktop,
Windsurf) bağlayan röle sunucusu ve kontrol düzlemi.

Android uygulaması ayrı depoda: **AI-Browser-Project-Claude**

## Bu sunucu ne yapar, ne yapmaz

**Yapar:** Bir MCP istemcisinden gelen komutu, o istemcinin eşleştirildiği tek
cihaza yönlendirir. Kimlik bilgisini hash'iyle doğrular, hesapları ve cihaz
bağlarını tutar, kotayı ve sınırları uygular.

**Yapmaz:** Kimlik üretmez, izin vermez. Bir komutun *nereye* gideceğine bu
sunucu, *çalışıp çalışmayacağına* telefon karar verir. Yetkilendirme kararı
buraya taşınmamalı — sunucu ele geçirilse bile kimsenin oturum açmış tarayıcısı
sürülememeli.

## Kontrol düzlemi

`/` adresinde hesap tabanlı bir panel var. Her sorgu, giriş yapan hesabın kendi
verisiyle sınırlıdır: bir hesap diğerinin cihazını, istemcisini veya denetim
kaydını **hiçbir uçtan** göremez. Bunun testi yazılı.

| Sayfa | Ne yapar |
| --- | --- |
| `/` | Cihazlar, AI istemcileri, kota, cihaz bağlama kodu girişi |
| `/audit` | Denetim kaydı, cihaz/istemci süzgeci, CSV dışa aktarım |
| `/account` | Parola değiştirme, diğer oturumları kapatma |

Panel tamamen sunucuda render edilir ve **hiç JavaScript içermez**; sayfalar
`script-src 'none'` ile gelir, çünkü ekranda gösterilen cihaz ve istemci adlarını
başkaları yazmıştır.

Tek operatörlük `ADMIN_TOKEN` konsolu kaldırıldı. Tek bir paylaşılan token,
rölendeki her cihazı ve her telefonun ziyaret ettiği host'ları listeliyordu;
hesaplar gelince bu bir kolaylık değil, bir kiracının diğerinin gezinti
geçmişini okuması demek.

### Cihaz bağlama

Telefon, açık soketi üzerinden röleden 8 karakterlik, 10 dakikalık, tek
kullanımlık bir kod ister; sahibi bu kodu panele girer ve cihaz hesaba geçer.

"İlk talep eden sahiplenir" kaydı kaldırıldı — o kural yalnızca kayıt defteri
tek kişinin telefonuyken savunulabilirdi: durum dosyası kaybolduğunda her
`deviceId` yeniden sahiplenmeye açılıyordu, boş bir istemci listesiyle kaydolup
gerçek cihazın anahtarlarını silmek dahil.

Sahipsiz cihazlar komut yönlendirmeye devam eder. Bu yükseltme yolu, açık kapı
değil: yönlendirme hâlâ yalnızca gerçek telefonun üretebileceği bir istemci
sırrı ister. Yalnızca kimsenin panelinde görünmezler.

### Depolama

Hesaplar, panel oturumları, cihazlar, istemciler, bağlama kodları, denetim kaydı
ve kota sayaçları `DATABASE_URL` tanımlıysa **PostgreSQL**'de tutulur.

Tanımlı değilse röle bir JSON dosyasına düşer ve bunu hem açılışta hem panelde
açıkça söyler. O yedek, veritabanı olmadan geliştirme yapabilmek içindir —
dağıtım seçeneği değildir: Render'ın konteyner dosya sistemi her dağıtımda
sıfırlanır, yani hesaplar da onunla gider.

### Sınırlar

`lib/limits.js`, her biri ortam değişkeniyle ayarlanabilir:

| Sınır | Varsayılan | Neyi korur |
| --- | --- | --- |
| Giriş denemesi | 10 / 10 dk | Parola kaba kuvveti |
| İstemci kimlik hatası | 20 / 5 dk | Anahtar tarama |
| Eşzamanlı SSE kanalı | 5 / istemci | Bellek şişmesi |
| Günlük komut | 5.000 (ücretsiz plan) | Kötüye kullanım |
| Cihaz sayısı | 1 (ücretsiz plan) | Hesap başına yayılma |

Komut kotası bilerek cömert: iş kullanıcının kendi telefonunda çalışıyor, röleye
maliyeti birkaç yüz bayt yönlendirme. Tight bir komut sınırı maliyet kontrolü
değil, yapay bir sakatlama olurdu.

Cihazdaki eşzamanlılık sınırı (aynı anda 3 komut) röleye **taşınmadı**: o,
telefonun pilini ve belleğini koruyor ve bir komutun gerçekten bittiğini yalnızca
telefon biliyor.

## Deploy (Render)

1. Render Dashboard → **New → Blueprint** → bu depoyu seç.
2. `render.yaml` bir web servisi ve bir PostgreSQL veritabanı tanımlar;
   `DATABASE_URL` otomatik bağlanır.
3. Deploy bitince `/` adresine gidip ilk hesabı oluştur.
4. Hesabın hazır olunca Environment sekmesinden `ALLOW_REGISTRATION=false` yapıp
   kayıtları kapat.
5. Android uygulamasında **Ayarlar → MCP** ekranına köprü adresini gir, bağlan,
   ardından **Hesaba bağla** ile kod alıp panele gir.

### Dikkat: tek instance

Bağlı cihazların WebSocket'leri ve açık MCP oturumları bellekte tutuluyor.
Birden fazla instance çalışırsa cihazın soketi bir instance'a, araç çağrıları
başkasına düşer ve köprü sessizce bozulur. Kayıt defteri artık Postgres'te ama
soketler paylaşılamaz — `numInstances: 1` olarak bırak.

## Yerel çalıştırma

```bash
npm install
cp .env.example .env
npm start
```

`.env` dosyası açılışta otomatik okunur (Node 20.12+ yerleşik desteği).
`DATABASE_URL` boş bırakılırsa röle dosya deposuyla çalışır — geliştirme için
yeterli, dağıtım için değil.

Testler bağımlılık gerektirmez; gerçek sunucuyu ve gerçek bir WebSocket'i
kullanırlar:

```bash
npm test
```

## Uçlar

| Uç | Kimlik | Ne yapar |
| --- | --- | --- |
| `GET /sse` | İstemci anahtarı | MCP SSE kanalı |
| `POST /message` | İstemci anahtarı | JSON-RPC araç çağrıları |
| `POST /tools/*` | İstemci anahtarı | REST yedek uçları |
| `GET /healthz` | Yok | Sağlık kontrolü |
| `GET /`, `/audit`, `/account` | Panel oturumu | Kontrol paneli |
| `GET /api/status` | Panel oturumu | Kendi hesabının cihaz/istemci/kotası |
| WebSocket `/` | `deviceSecret` | Android cihaz bağlantısı |

## Kimlik doğrulama

İki ayrı kimlik sistemi var ve bilerek ayrılar:

- **İstemci anahtarı** komutları çalıştırır. Panel oturumu hiçbir tarayıcı
  süremez.
- **Panel oturumu** hesabı yönetir. İstemci anahtarı panele giremez.

Bu ayrım, röle ele geçirilse bile kimsenin adına gezilememesinin sebebi.

MCP istemcileri `Authorization: Bearer <clientId>.<secret>` gönderir. Bu değeri
**telefon** üretir: kullanıcı uygulamada *Ayarlar → Oturumlar → AI istemcisi
ekle* der, cihaz anahtarı oluşturur ve gösterir, kullanıcı kopyalayıp MCP
yapılandırmasına yapıştırır. Anahtar kalıcıdır ve istemci kartından istenildiği
zaman tekrar kopyalanabilir; sızma şüphesinde aynı karttan yenilenir (kimlik,
çerez profili ve izinler korunur, yalnızca sır değişir).

Telefon röleye **yalnızca `sha256(secret)`** bildirir. Röle hash'i ve
`clientId → deviceId` bağını tutar; **düz metin sır röleye hiçbir zaman
yazılmaz.** Düz metni yalnızca telefon, kendi uygulamasına özel deposunda tutar.

Anahtar **sorgu dizesinden kabul edilmez** — yalnızca `Authorization` başlığı
veya `X-Mcp-Token`. Bir sır URL'ye girdiği anda platformun erişim loglarına ve
aradaki her vekile düşer, ve bunların hiçbiri geri alınamaz.

Rastgele veya uydurma bir token ile bağlanmak mümkün değildir: `clientId`
kayıtlı değilse istek 401 döner, kayıtlıysa da telefon sırrı kendi defterine
karşı ayrıca doğrular. Başarısız denemeler IP başına sayılır.

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

## Markdown

Tek bir okuma aracı var: `browser_get_markdown`. Dönüşüm tamamen **cihazda**
yapılır ve röle sayfayı hiçbir dış servise göndermez.

Buradaki Crawl4AI servisi kaldırıldı. Cihazın kendi dönüştürücüsü genel bir
HTML→Markdown dönüştürücü değil, `browser_click` ile aynı numaralandırmayı
paylaşan bir *etkileşim haritası* üretiyor; dış bir dönüştürücü bunu koruyamıyor,
üstelik karşılığında giriş yapılmış sayfaların ham DOM'u üçüncü bir servise
gidiyordu. Eski `browser_get_local_markdown` ve `browser_get_crawl4ai_markdown`
adları geriye dönük uyumluluk için hâlâ kabul ediliyor.

## Deploy sonrası

Sunucu `SIGTERM`/`SIGINT` aldığında bekleyen denetim kayıtlarını yazar, MCP
oturumlarını kapatır ve telefonlara 1001 ("going away") gönderir; telefon bunu
arıza değil yeniden başlatma sayar ve normal backoff'uyla hemen bağlanır.

## Loglar

Denetim kaydı yalnızca meta veri tutar: araç adı, süre, alan adı, sonuç. Sayfa
içeriği, tam URL ve kimlik bilgisi hiçbir zaman yazılmaz — bu köprü oturum
açılmış tarayıcı trafiği taşıyor ve log en kolay sızan şey. Bunu doğrulayan bir
test var.

Kayıtlar hesap başına süzülür ve plana göre 7–90 gün saklanır; panelden CSV
olarak dışa aktarılabilir.

## Bilinen sınırlar

- Tek instance zorunlu (yukarıya bakın)
- Ücretsiz Render planında servis hareketsizlikte uykuya geçer; uygulama
  otomatik yeniden bağlanır ama ilk komutta soğuk başlangıç gecikmesi olur
- Render'ın ücretsiz PostgreSQL planı süreli — dolduğunda hesaplar ve cihaz
  bağları gider. Telefonlar çalışmaya devam eder, ama her cihaz yeniden
  bağlanana kadar sahipsiz görünür
