# Güvenlik düzeltmeleri — 30 Eylül 2026

İncelemede raporlanan dört konu kaynaklarda düzeltildi. Son sunucu test çalışması **141/141 başarılı**, eklenen güvenlik testleri **20/20 başarılı**. Bağımlılık taramasında **0 bilinen açık** var. GitHub/Render yayını ve Android dil desteği için yapılan sonraki doğrulamalar aşağıda belirtilmiştir.

## Yapılan değişiklikler

### 1. Sunucu kaynaklarının sınırsız kayıtlarla tüketilmesi

- Başarılı cihaz kaydı artık WebSocket bağlantı denemesi sayacını sıfırlamıyor.
- Yeni cihaz kimlikleri için IP başına ve sunucu genelinde ayrı saatlik bütçeler eklendi. Mevcut cihazın yeniden bağlanması yeni cihaz bütçesini tüketmiyor.
- Hesaba bağlanmamış cihazın yeni AI bağlantıları, hem ilk kayıt listesinde hem sonraki eklemelerde sınırlandırılıyor. İlk listedeki tekrar eden kimlikler tek kez sayılıyor.
- Doğrulanmış bağlantıları da kapsayan toplam açık soket sınırı ve toplam cihaz/AI bağlantısı kayıt kapasitesi eklendi.
- Farklı soketlerden gelen kayıt ve bağlantı ekleme işlemleri sıraya alındı. Böylece aynı son kapasiteyi eşzamanlı kullanmak veya ilk cihaz kaydının sırrını yarışla değiştirmek engelleniyor.
- Kapasite ve mevcut kimlik kontrolleri depodaki kayıtlara dayanıyor. Önbellek yenilemesi başarısız olsa da kaydedilmiş bağlantılar yeniden bağlanırken korunuyor.
- Kayıt temizliği ve dosya deposundaki bağlantı listesi, iç içe aramalar yerine küme/harita üzerinden hazırlanıyor.

Mevcut hesapsız kurulumların çalışması ve cihazın yerel yetki denetimi korunur. Sonradan düşürülen kapasite sınırları mevcut kayıtları silmez; yeni eklemeleri sınırlar. PostgreSQL ve dosya deposunda aynı veri sorguları sağlandı.

Kaynaklar: [kayıt bütçeleri](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/lib/limits.js:54), [soket sınırı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1930), [cihaz kaydı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:2008), [bağlantı ekleme](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1745).

### 2. Önbellek yenilenirken askıya alma kontrolünün aşılması

Yeni cihaz, AI bağlantısı ve hesap haritaları tamamen hazırlandıktan sonra bekleme olmadan birlikte yayımlanıyor. Yenilemeler sırayla çalışıyor; okuma hatasında son tamamlanmış önbellek korunuyor. Bir bağlantının hesap kimliği varsa ancak hesap bilgisi bulunamıyorsa komut **503** ile reddediliyor.

250 ms depo gecikmesi kullanılan kontrollü denemede, askıya alınmış hesabın yanıtları artık **403 → 403 → 403**. Sahte cihaza iletilen komut sayısı **0**. Başarısız yenileme ve eksik hesap bilgisi ayrıca test edildi.

Kaynaklar: [önbelleğin hazırlanması ve yayımlanması](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:209), [eksik hesabın reddedilmesi](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1610).

### 3. OAuth metadata üzerinden özel ağa istek yapılması

IP adresleri standart biçimde ayrıştırılıyor. IPv4 taşıyan IPv6 adreslerinde gömülü IPv4 de kontrol ediliyor. Özel, loopback, yerel bağlantı, ayrılmış ve geçiş aralıkları reddediliyor. DNS yanıtındaki tüm adresler doğrulanıyor; bağlantı doğrulanan adrese sabitlenmeye devam ediyor. HTTPS yönlendirmeleri takip edilmiyor.

Ek olarak DNS çözümlemesi ve gövde aktarımını birlikte kapsayan **5 saniye** toplam süre sınırı, **16** eşzamanlı metadata işlemi, **64 KiB** gerçek bayt sınırı ve OAuth yetkilendirmesinde IP başına istek bütçesi var. Süresi dolmuş bir DNS cevabı sonradan bağlantı başlatamıyor. Genel internet adreslerinden geçerli metadata alınması da test edildi.

Önceki kontrollü `::ffff:127.0.0.1` denemesi artık HTTPS isteği oluşturulmadan reddediliyor.

Kaynaklar: [adres kontrolü](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/lib/oauth.js:344), [metadata sınırları](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/lib/oauth.js:407), [OAuth istek bütçesi](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:3280).

### 4. Güvenlik uyarısı bulunan bağımlılıklar

Express **4.22.3**, body-parser **1.20.8** ve qs **6.16.0** sürümlerine geçildi; kilit dosyası güncellendi. IP sınıflandırması için doğrudan ipaddr.js **2.5.0** bağımlılığı eklendi. Mevcut proxy-addr bağımlılığı kilit dosyasıyla eşitlendi. Güncel taramada kritik, yüksek, orta ve düşük seviyelerin tamamı **0**.

Kanıtlar: [bağımlılık taraması](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/fix-dependencies.json), [kurulu bağımlılık ağacı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/fix-dependency-tree.txt).

## Varsayılan sınırlar

Sunucu ortam değişkenleriyle ayarlanabilir. Açıklamalar [.env.example](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/.env.example:77) dosyasında bulunur.

| Denetim | Varsayılan |
| --- | --- |
| WebSocket denemesi | IP başına dakikada 30 |
| Yeni cihaz kimliği | IP başına saatte 20 |
| Yeni cihaz kimliği, sunucu toplamı | Saatte 200 |
| Hesapsız cihazın AI bağlantıları | 10 |
| Toplam cihaz kaydı | 10.000 |
| Toplam AI bağlantısı kaydı | 100.000 |
| Toplam açık cihaz soketi | 1.000 |
| OAuth yetkilendirme isteği | IP başına dakikada 30 |

## Doğrulama ve sınırlar

- `npm test`: **141 başarılı, 0 başarısız, 0 atlanmış**. [Son çıktı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/fix-server-tests.txt).
- `node --test test/security-hardening.test.js`: **20/20**. Kayıt sınırları, eşzamanlı eklemeler, eski kayıtların korunması, depo/önbellek hataları, askıya alınmış hesaplar, özel adresler ve metadata kaynak sınırlarını kapsar. [Çıktı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/hardening-tests.txt).
- `node docs/reviews/2026-09-30/reproduce.cjs --fixed`: Önceki bulguları üreten sınırlı yerel denemeler düzeltmelerden sonra yeniden çalıştırıldı. 120 yeni AI bağlantısı girişinden yalnızca 10'u saklandı; bağlantı bütçesi dolunca sonraki el sıkışma 429 ile reddedildi. [Sonuçlar](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/fixed-reproduction-results.json). Betiğin varsayılan modu tarihsel açık davranışı bekler; güncel kodda `--fixed` kullanılmalıdır.
- İlk tam çalışmada mevcut operatör plan süresi testinin zaman karşılaştırması başarısız oldu. Kod değiştirilmeden tek başına ve ardından bütün paket yeniden çalıştırıldığında geçti. [İlk çalışma](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/fix-server-tests-first-run.txt), [tekil kontrol](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/plan-deadline-recheck.txt).
- Değişen JavaScript dosyalarının sözdizimi ve değişikliklerin boşluk denetimi başarılı.
- PostgreSQL test veritabanı yapılandırılmadığından PostgreSQL entegrasyon testleri çalıştırılmadı. Gecikme/hata testleri geçici dosya deposunda kontrollü taklitle yapıldı.
- Android kaynakları bu düzeltme kapsamında değiştirilmedi. Önceki Android test denemesi eksik `android-36.1` SDK nedeniyle çalışamamıştı; Android için başarılı test sonucu iddia edilmiyor.
- Canlı sunucuya, gerçek kullanıcı hesaplarına veya iç ağ servislerine test uygulanmadı. Gerçek üretim kapasitesi ölçülmedi. Bunlar raporlanan bulguların düzeltmeleridir; tüm olası güvenlik risklerinin yokluğunu kanıtlamaz.

## GitHub/Render ve dil desteği için sonraki doğrulama

- Render deposu için güncel kilit dosyasıyla ayrı `npm ci` kurulumu yapıldı: **0 bilinen bağımlılık açığı**. Ayrı depoda sunucu testleri **141/141 başarılı**. [Kurulum](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/render-dependency-install.txt), [testler](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/render-server-tests.txt).
- Mevcut plan süresi testi Render doğrulamasının ilk çalışmasında da dar zaman karşılaştırmasından başarısız oldu. Windows'ta iki ayrı süreç arasındaki karşılaştırmaya 50 ms tolerans ve açıklayıcı hata mesajları eklendi. Gün/ay/yıl süre hesabı değişmedi; ana ve Render depolarının tüm testleri sonrasında geçti.
- Android ortamında `android-36.1` artık mevcut. Son çalışmada **165/165 birim testi başarılı** ve `compileDebugAndroidTestKotlin` başarılı. Önceki eksik SDK sonucu tarihsel kayıt olarak korunmuştur. [Güncel Android çıktısı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/language-android-tests.txt). Gerçek cihaz testleri bu çalışmada çalıştırılmadı.
- İngilizce katalog; yeni sekme ekranı, bağlantı hataları, kayıt sınırı uyarıları, form onayları ve işlem geçmişindeki eksik metinleri kapsayacak şekilde tamamlandı. Bileşik durum mesajlarının sabit parçaları çevrilirken cihaz/istemci adları ve site adresleri korunuyor. Erişilebilirlik açıklamaları, tarihler ve üyelik sayı biçimleri uygulamada seçilen dili takip ediyor. Türkçe kaynak metinler ve Türkçe dil seçeneği korunuyor.
- Beş yeni dil testi; ekran metinlerini, formun bütününü kapsayan onay açıklamalarını, aktarılan verilerin röleden geçmesi uyarısını, sunucu reddini, cihaz değiştirme bilgisini ve değişmeden kalması gereken özel ad/adresleri doğruluyor.
- AI araç adları, açıklamaları ve parametre şemaları `server.js` içindeki `TOOLS` ve `AI_TOOL_COPY` üzerinden sunucudan gelir. `tools/list` bu listeyi döndürür. Tarayıcıya ilişkin komutun yetki/onay denetimi ve WebView işlemi telefonda yapılır. Bazı yardımcı yanıtlar (örneğin araç dokümantasyonu ve cihaz listesi) sunucuda hazırlanır.
