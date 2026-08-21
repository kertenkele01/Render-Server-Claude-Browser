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

**Kullanıcı tarafı bu sunucuda değil, uygulamada.** Röle bir JSON API sunuyor,
Android uygulaması onu kullanıyor; kullanıcı hiçbir web sayfasına
yönlendirilmiyor.

| Uç | Ne yapar |
| --- | --- |
| `POST /api/v1/register` | Hesap oluşturur ve çağıran cihazı bağlar |
| `POST /api/v1/login` | Giriş yapar ve çağıran cihazı bağlar |
| `POST /api/v1/logout` | Cihazın hesapla bağını koparır |
| `GET /api/v1/account` | E-posta, plan, kota, cihaz/istemci sayısı |
| `POST /api/v1/account/password` | Parola değiştirir |
| `GET /api/v1/audit` | Hesabın denetim kaydı |

Bu uçlar hesap oturumuyla değil, telefonun zaten elinde olan
`<deviceId>.<deviceSecret>` kimliğiyle doğrulanır. Uygulama hesap parolasını veya
oturum çerezini hiç saklamaz, ve **bağlama örtüktür**: giriş yapan cihaz,
bağlanan cihazdır.

### Panel operatörler için

`ADMIN_EMAILS` içinde adı geçen hesaplar `/` adresinde şunları görür: röle
toplamları (hesap, cihaz, istemci, açık kanal, bugünkü komut, sahipsiz cihaz),
hesap listesi ve hesap başına askıya alma / plan değiştirme.

Normal bir hesap panele düşerse "her şey uygulamada" sayfasını görür — hata
değil, yönlendirme.

**Operatör başka bir hesabın denetim kaydını göremez.** Kullanıcı yönetmek için
sayaç ve durum yeterli; hangi siteleri gezdikleri operatörün işi değil.
`/audit` giriş yapan operatörün kendi hesabıyla sınırlıdır.

Yönetici olmak ortam değişkeninden gelir, arayüzden değil: kendini terfi
ettirmek bir kayıt işleminin yapabileceği bir şey olmamalı.

Tek operatörlük `ADMIN_TOKEN` konsolu kaldırıldı. Tek bir paylaşılan token,
rölendeki her cihazı ve her telefonun ziyaret ettiği host'ları listeliyordu.

Panel tamamen sunucuda render edilir ve **hiç JavaScript içermez**; sayfalar
`script-src 'none'` ile gelir, çünkü ekranda gösterilen hesap ve cihaz adlarını
başkaları yazmıştır.

### Cihaz bağlama

Kullanıcı uygulamadan giriş yaptığında cihaz kendiliğinden bağlanır. Bağlama
kodu mekanizması duruyor (telefon soketten ister, panele girilir) ama yalnızca
operatörün kendi işi için.

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
3. Environment sekmesinden `ADMIN_EMAILS` değerine kendi e-postanı yaz.
4. `/` adresine gidip o e-postayla hesabı oluştur — konsolu yalnızca o hesap
   görür.
5. Kayıtları kapatmak istersen `ALLOW_REGISTRATION=false` yap.
6. Kullanıcılar panele hiç uğramaz: uygulamayı kurar, **Ayarlar → MCP → Hesap**
   bölümünden kaydolur ve cihazları kendiliğinden bağlanır.

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
| `POST /api/v1/*` | Cihaz kimliği | Uygulama API'si (hesap, kota, kayıt) |
| `GET /`, `/audit`, `/account` | Operatör oturumu | Operatör konsolu |
| `GET /api/status` | Operatör oturumu | Röle toplamları ve hesap listesi |
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
  varsayılan kapalı) bağlıdır. `browser_fill_form` bütün bir formu **tek**
  onayla sorar: art arda on onay kutusu, kullanıcının onayları okumayı
  bırakmasına yol açar ve bu koruduğundan fazlasına mal olur.
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

## Form araçları

Röle bunları da yalnızca taşır, ama uçları ve şemaları burada tanımlı olduğu
için sürümlerin uyuşması gerekir: cihazda olup röle şemasında olmayan bir araç
istemciye hiç görünmez, tersi ise `Tool not found` döner.

| Araç | Neden ayrı bir araç |
| --- | --- |
| `browser_select_option` | WebView'da bir `<select>`'e dokunmak Android'in kendi seçicisini açar. O pencere sistem arayüzüdür, sayfanın parçası değildir; ajan onu okuyamaz, oradan seçemez. Tıklama "başarılı" dönerken değer hiç değişmiyordu. |
| `browser_pick_date` | Rezervasyon siteleri `input type=date` kullanmıyor; hücrelerinde yalnızca gün sayısı yazan bir ızgara çiziyorlar. Cihaz hücreyi ISO tarihe çözüyor ve gerekirse doğru aya kadar yürüyor. |
| `browser_read_form` | Tek okuma aracı sayfanın tamamını 80k'lık pencerelerde döndürüyor; bir form sayfasında bunu her alandan sonra çağırmak karşılanamaz. Bu araç yalnızca alanları döner. |
| `browser_fill_form` | Tek turda 30 alana kadar, tek onayla. |
| `browser_handle_dialog` | `alert`/`confirm`/`prompt` sayfanın JS iş parçacığını bloke eder; açıkken hiçbir komut çalışamaz, dolayısıyla yanıt kutu açılmadan **önce** ayarlanır. |

`test/tool-registry.test.js` bu uyumu kaynaktan doğruluyor: her araç şemasının
bir komut karşılığı, bir REST yolu ve bir doküman kaydı olduğunu kontrol eder.
Bir araç eklemek birbirinden habersiz dört yere dokunmak demek ve birini
atlamanın bedeli, istemcinin aracı görüp çağırınca hata almasıdır.

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
