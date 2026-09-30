# Güvenlik incelemesi — 30 Eylül 2026

> **Düzeltme durumu:** Bu belge düzeltme öncesi bulguları ve kanıtları korur. Raporlanan dört konu yerel kaynaklarda giderildi. Güncel değişiklikler ve doğrulama sonuçları [düzeltme raporunda](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/docs/reviews/2026-09-30/duzeltmeler.md) bulunur. Aşağıdaki kaynak satırları inceleme sırasındaki kodu gösterir; değişiklikler nedeniyle kaymış olabilir.

**Sonuç:** İncelenen yerel kaynaklarda iki yüksek öncelikli sunucu sorunu ve bir orta öncelikli adres doğrulama sorunu bulundu. Ayrıca bağımlılık taraması güncelleme gerektiren bir paket gösterdi. Hesap ele geçirme, başka bir kullanıcının WebView profilini kullanma veya sunucuda uzaktan kod çalıştırma sağlayan kritik bir açık bu incelemede doğrulanmadı. Bu sonuç, uygulamanın bütünüyle güvenli olduğuna dair bir garanti değildir.

İnceleme, çalışma dizininin mevcut hâlini ve inceleme öncesinde var olan yerel değişiklikleri kapsar. Canlı dağıtımın bu kodu kullanıp kullanmadığı, ağ ayarları ve iç servisleri incelenmedi. Uygulama ve sunucu kaynakları değiştirilmedi.

## 1. Yüksek / P1 — Hesapsız kayıtlarla sunucu kaynakları sınırsız büyüyebiliyor

Kaynaklar: [bağlantı denemesi sınırı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1889), [başarılı kayıtta sayacın sıfırlanması](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:2052), [hesapsız kayıtta oturum sınırı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:2029), [sonraki oturum eklemelerindeki istisna](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1720), [önbelleğin tümünün okunması](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:204).

Yeni cihaz kimliği ve sırrı, kayıt mesajını gönderen taraftan kabul ediliyor. Bu, mevcut hesapsız kurulumların çalışması için tasarlanmış bir davranış; tek başına başka cihazın yetkisini vermez. Ancak başarılı kayıt IP başına WebSocket deneme sayacını sıfırladığı için aynı kaynak yeni kimliklerle sürekli kayıt olabiliyor. Hesabı olmayan cihazlar için AI oturumu sayısı da sınırlandırılmıyor: ilk kayıt listesinde `Number.MAX_SAFE_INTEGER`, sonraki `client_added` akışında doğrudan izin var.

Henüz doğrulanmamış bağlantılara konan 64 küresel / 8 IP başına bağlantı sınırı, kayıt tamamlanınca bırakılıyor. 1 MiB mesaj sınırı her mesajı sınırlar; biriken toplam cihaz ve oturum sayısını sınırlandırmaz. Kayıtlar depoya yazılıyor, her kayıtta tüm cihaz/oturum tabloları tekrar okunuyor. Ön bellekteki mevcut oturumların silinmesini denetleyen döngü de her kimlik için listede yeniden arama yapıyor; toplam oturum sayısı arttıkça bu bölümün işi yaklaşık karesel büyüyebiliyor.

**Kanıt:** Geçici yerel sunucuda `LIMIT_WEBSOCKET_MAX=2` ve `LIMIT_REGISTER_MAX=2` ile aynı kaynakta altı yeni cihaz kaydı başarılı oldu. Bunlardan hesapsız tek cihazın ilk mesajındaki 120 oturumun tamamı kalıcı dosya deposuna yazıldı. Hesap açılmadı. Test sınırlı tutuldu ve sunucu çökertilmedi; gerçek üretim kapasitesinin hangi noktada tükeneceği ölçülmedi.

**Etki:** İnternete açık sunucuda kayıt birikimi bellek, disk/veritabanı ve işlem süresini tüketerek gecikme, bağlantı reddi veya yeniden başlama yaratabilir. Başka kullanıcının tarayıcı oturumuna erişim bu bulguyla gösterilmedi.

**Düzeltme:** Başarılı kayıtların da tükettiği ayrı IP/küresel kayıt bütçesi tanımlayın ve başarıda sıfırlamayın. Hesapsız cihaz başına oturum sayısını hem ilk kayıt hem sonraki ekleme için sınırlayın. Doğrulanmış soketlerin toplamını ayrıca sınırlayın. Mevcut hesapsız kurulumların geçiş yolunu koruyarak yeni kayıtların büyümesini denetleyin. Önbelleği artımlı güncelleyin veya yeni kimlikleri `Set` üzerinden kontrol edin. Sadece mesaj boyutunu azaltmak bu sorunu çözmez.

## 2. Yüksek / P1 — Hesap önbelleği yenilenirken askıya alma kontrolü açık kalıyor

Kaynaklar: [önbelleğin önce temizlenmesi](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:230), [hesap yoksa null kabul edilmesi](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1592), [askıya alma koşulu](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:1635).

`refreshRegistryCache()` hesap önbelleğini boşalttıktan sonra hesapları tek tek, beklemeli depo okumalarıyla dolduruyor. Bu aralıkta müşterinin `accountId` alanı mevcut olduğu hâlde hesabı önbellekte bulunamayabiliyor. `authenticate()` bunu `account=null` olarak döndürüyor; `requireAuth()` askıya alma kontrolünü yalnızca hesap nesnesi mevcutsa uyguluyor. Sonuçta hesabı geçici olarak bulunamayan bir müşteri, kimliksiz hesapsız müşteri gibi değerlendirilip bu kontrolden geçiyor.

**Kanıt:** Yerel sunucuda askıya alınmış hesap ve o hesabın mevcut geçerli müşteri anahtarı kullanıldı. Depodaki `getAccountById()` okumalarına 250 ms gecikme eklenerek asenkron veritabanı okuması temsil edildi. `browser_list_tabs` isteği yenilemeden önce **403**, yenileme sırasında **200**, yenileme tamamlanınca yeniden **403** döndü. Aralıktaki bir komut sahte cihaza iletildi ve cevaplandı.

**Sınır:** Bu, PostgreSQL ile veya gerçek Android WebView üzerinde yapılmış bir test değildir. Dosya sürücüsüne eklenen okuma gecikmesiyle yarış aralığı görünür hâle getirildi. Kullanıcı tarayıcısında gerçek işlem gerçekleştirilmedi. Telefonun yerel müşteri anahtarı, izinleri ve devralma kontrolleri ayrı korumalar olarak kalır.

**Etki:** Askıya alınmış bir hesabın önceden geçerli anahtarı, kayıt/önbellek yenilemesi sırasında sunucunun askıya alma engelini aşabilir. Hesap durumuna bağlı diğer sunucu kontrolleri de eksik hesap nesnesinden etkilenebilir. Günlük kota sayacı müşteri kaydındaki hesap kimliğiyle çalıştığından bu bulguyu günlük kotanın tamamen kalkması olarak yorumlamamak gerekir.

**Düzeltme:** Yeni hesap önbelleğini ayrı bir haritada tamamen hazırlayıp atomik olarak değiştirin. Yenilemeleri sıraya koyun veya eski bir yenilemenin yenisini ezmesini engelleyin. Müşterinin hesap kimliği mevcutken hesap nesnesi bulunamıyorsa geçici hata verin; hesapsız müşteri yoluna düşürmeyin.

## 3. Orta / P2 — OAuth metadata adresi IPv4 taşıyan IPv6 üzerinden özel ağa yönlenebiliyor

Kaynaklar: [özel IP kontrolü](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/lib/oauth.js:343), [DNS kontrolü ve sabitlenmiş adresle istek](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/lib/oauth.js:411), [kimlik doğrulaması gerekmeyen yetkilendirme akışı](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/server.js:3093).

`resolveClientMetadata()` HTTPS adresini DNS ile çözüyor, özel IP'leri reddediyor ve bağlantıyı kontrol edilen adrese sabitliyor. Ancak `isPrivateAddress()` IPv6 için yalnızca belirli önekleri kontrol ediyor. `::ffff:127.0.0.1` gibi IPv4 taşıyan IPv6 adresleri bu kontrolden geçiyor. Bu adres işletim sisteminde loopback IPv4 bağlantısına karşılık geliyor. Aynı biçim özel IPv4 aralıklarını da taşıyabiliyor.

**Kanıt:** DNS cevabı kontrollü olarak `::ffff:127.0.0.1` yapıldığında gerçek OAuth fonksiyonu HTTPS istek oluşturma adımına geçti ve bu adresi bağlantı için kullandı. HTTPS isteği testte yakalanıp durduruldu. Ayrı, yalnızca yerel TCP denemesi bu biçimin 127.0.0.1 üzerinde açılan dinleyiciye ulaştığını gösterdi.

**Sınır:** DNS ve HTTPS araçları testte taklit edildi; gerçek dış DNS kaydı veya iç HTTPS servisine uçtan uca saldırı kurulmadı. Gerçek saldırı hedef işletim sisteminin DNS davranışına, ağ çıkışına, HTTPS/TLS koşullarına ve erişilebilir servislere bağlıdır. Yerel ağdan veri çalındığı gösterilmedi.

**Etki:** Kontrol edilen hostname için uygun DNS cevabı sağlanabilirse sunucu özel ağdaki HTTPS adreslerine istek yapabilir (SSRF). Kimlik doğrulaması gerekmez. İç servisin niteliğine göre etki büyüyebilir; mevcut kanıtla doğrudan hesap ele geçirme iddiası yoktur.

**Düzeltme:** IP'leri tek bir standart biçime normalleştirin; IPv4 taşıyan IPv6 adreslerinde gömülü IPv4 adresini de sınıflandırın. Genel internet dışındaki aralıkları kapsamlı biçimde engelleyin. Kontrol edilen DNS adresine bağlantıyı sabitleme korumasını koruyun. Metadata okumalarına toplam süre ve eşzamanlı istek sınırı ekleyin.

## 4. Orta / koşullu — qs bağımlılığı için güncel güvenlik uyarıları

Kaynak: [kilitli qs sürümü](C:/Users/kadir/Downloads/Browser-Mcp-Android-main/Browser-Mcp-Android-main/package-lock.json:714), [tarama çıktısı](security-audit-dependencies.json).

`npm audit` sıfır kritik, sıfır yüksek ve üç orta seviyeli paket kaydı döndürdü. Üç kayıt `qs`, `express` ve `body-parser` içindir; `express` ve `body-parser` aynı `qs` riskinin bağımlılık zincirindeki yansımalarıdır. Bu nedenle bunlar üç bağımsız uygulama açığı olarak sayılmamalıdır.

Projede kilitli `qs` sürümü 6.15.3. İki danışma kaydı mevcut: [isBuffer kaynaklı hata](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) ve [dizi sınırı atlama](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx). İlk kayıt, güvensiz nesneyle `qs.stringify()` çağrılması koşuluna bağlıdır. Bu uygulamada o zincirden sunucu çökmesi gösterilmedi. İkinci kayıt ilgili ayrıştırma seçeneklerine bağlıdır; uygulamanın gövde boyutu sınırı ayrıca vardır.

**Düzeltme:** Üst paketleri ve kilit dosyasını güncelleyerek düzeltilmiş `qs` sürümüne geçin; 6.16.0 isBuffer kaydının düzeltilmiş sürümüdür. Gerçek kurulu bağımlılık ağacını tekrar tarayın ve sunucu testlerini çalıştırın. Bu incelemede bağımlılıklar güncellenmedi.

## Testler ve inceleme sınırları

- Sunucu: **121/121 test başarılı**, sıfır başarısız/atlanmış test. [Çıktı](server-tests.txt).
- Ek kontrollü doğrulama: [sonuçlar](reproduction-results.json), [tekrar üretim betiği](reproduce.cjs). Betik yalnızca kendi geçici loopback sunucusunu kullanır; kurmaca kimlikler ve en fazla altı yeni cihaz/120 oturumla sınırlıdır. Çalıştırma: `node docs/reviews/2026-09-30/reproduce.cjs`.
- Android birim testleri denenmiştir; kurulu SDK'da `android-36.1` bulunamadığından görev başlamadan derleme durmuştur. Android testleri başarılı sayılmamıştır. [Çıktı](android-tests.txt).
- PostgreSQL test veritabanı yapılandırılmamıştı; PostgreSQL testleri çalıştırılmadı.
- Canlı sunucu, gerçek hesaplar, iç ağ servisleri ve gerçek Android cihazına saldırı/test uygulanmadı. Kapasite veya hizmeti çökertme testi yapılmadı.
- Kaynak incelemesinde cihazın yerel anahtar doğrulaması, izin/onay kapıları, tab sahipliği ve devralma kontrolü, ayrı WebView profili zorunluluğu, HTTPS sınırı, Android yedeklerinin engellenmesi, parametreli SQL sorguları ve şifreli senkronizasyon paketleri kontrol edildi. Bu alanlarda yeni, doğrulanmış kritik bir aşma raporlanmadı.

**Öncelik:** Önce 1 ve 2; ardından 3 ve bağımlılık güncellemesi. İnternete açık bir dağıtımda ilk iki konu kısa vadede ele alınmalıdır.
