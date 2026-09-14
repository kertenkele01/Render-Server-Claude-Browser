# Yedek cihaz token yetkileri

14 Eylül 2026 — uygulama ve röle değişiklikleri yerelde tamamlandı.

## Kullanım

Ana cihazın hesap cihazları listesinde her yedek için üç ayrı seçim vardır:

- Mevcut Bearer anahtarını alma/gösterme ve OAuth bağlantı kodu çıkarma.
- Yeni bağımsız AI oturumu için token oluşturma ve paylaşılan oturumun tokenını yenileme.
- Kendini ana cihaz olarak seçebilme. Yedek başka bir cihazı ana cihaz yapamaz.

Token yenileme varsayılan olarak kapalıdır. Token alma ve kendini ana cihaz seçme,
mevcut davranışı korumak için varsayılan olarak açıktır. Yenileme token alma iznini
de gerektirir. Bu yetkiler MCP sayfa izinlerinden ve çerez eşitlemesinden ayrıdır.

## Güvenlik ve sınırlar

Paylaşılan oturumun yeni sırrını artık yetkili yedek telefon kendisi üretir.
Ana/kaynak telefonun bağlı olması, uygulamasının hâlâ yüklü olması veya cihazın
hesaba bağlı kalması gerekmez. Yedek ilgili bağlantıyı kabul etmiş ve hesabın
şifreli veri anahtarını açabilir durumda olmalıdır. Mevcut token yenileme izni
yeterlidir; ek izin veya kaynak telefondan onay eklenmedi. Kaynak kimliği kayıt
metadatası olarak korunur; token değiştirme yetkisinin tek sahibi olmaktan çıkar.

Ana cihaz, yedek yetkilerini Android Keystore içindeki dışarı çıkarılamayan P-256
anahtarıyla imzalar ve ayrı alanlı hesap anahtarı HMAC kanıtını ekler. Yedek
üretmeden önce yetki imzasını ve bu kanıtı doğrular. Değişiklikte yeni hash, önceki
hash, token sürümü, hesap/oturum/cihaz kimlikleri ve tek kullanımlık işlem kimliği
imzalanır; ayrıca ayrı alanlı HMAC üretilir. Her alıcı telefon bu kanıtları
doğrulamadan yerel hash'i değiştirmez. Sunucu metadata'sı tek başına yeterli değildir.

Yedek yeni tokenın AES-GCM şifreli kopyasını ve doğrulama kanıtını sunucuya yollar.
Röle önceki hash/sürüm, güncel cihaz yetkisi, hesap bağlantısı ve veri anahtarı
sürümünü atomik kontrol ederek kaydeder. İki paralel farklı isteğin yalnızca biri
kabul edilir. Yeni hash'i ve şifreli paketi röle üretmez. Eski cihazın yeniden
kaydı veya çıplak client_added bildirimi yeni tokenı geri alamaz. Telefonlar eski
sürümün tekrar uygulanmasını reddeder.

Yedek, isteği ve ürettiği sırrı HTTP çağrısından önce uygulama özel deposunda
saklar; olumlu cevabı doğrulamadan aktif tokenı değiştirmez. Sonuç belirsizse aynı
isteği kullanır. Son kabul edilen işlem kanıtı kalıcıdır ve yeniden başlatmadan
sonra da aynı isteğin ikinci kez yenilemesine izin verilmez. Daha yeni bir işlem
varsa güncel token şifreli kopyasından alınır. Otomatik eşitlemenin açık olması gerekmez.

Token alma iznini kapatmak daha önce kopyalanmış anahtarları iptal etmez. Token
yenilemek eski Bearer ve OAuth erişimlerini geçersiz kılar; oturum kimliği,
izinleri, çerez profili ve sekmeleri korunur. Yetki iptali ve cihaz/hesap bağının
değişmesi bekleyen sonucun paylaşımında yeniden kontrol edilir. Cihazın token
alma tercihi uygulama yeniden başladığında envanter alınmadan da korunur.

## Doğrulama

- Sunucu: 82 test geçti. Yeni senaryolar imzalı yetki kapsamını, kalıcı kaydı,
  değişmez cihaz anahtarını, hesaplar arası erişim engelini, yetki iptalini,
  paralel/tekrar yenilemenin tek işlem kalmasını, kaynak çevrimdışı veya kaldırılmış
  durumunu, eski tokenın reddini, yeni tokenın kullanılmasını ve stale origin kaydını kapsar.
- Android: 133 birim testi geçti; uygulama ve cihaz testi APK'ları derlendi.
- Cihaz testi sınıfına Keystore/imza, şifreli yenileme sonucu, profil/izin korunması,
  tekrar isteği, gözetimsiz modda ilk onay, onay/ret, yetki sürümü, sahte imza,
  süresi dolmuş istek ve açılışta yerel yetki iptali senaryoları eklendi. Bağımsız
  üretim, ana cihaz seçili değilken mevcut izinle üretim, sahte hesap/yetki kanıtı
  ve eski token sürümünün reddi için cihaz senaryoları da eklendi.
- Dağıtım öncesi fiziksel cihaz testleri çalıştırılamadı: `192.168.1.7:36723` bağlantısı yanıt vermedi.
- PostgreSQL senaryosu test çalıştırıcısına eklendi; yerelde ayrı test veritabanı
  bulunmadığından PostgreSQL üzerinde çalıştırılmadı. Sunucu testleri dosya deposu
  ve gerçek HTTP/WebSocket bağlantılarıyla çalıştı.
- Bu geliştirme raporu oluşturulduğunda yeni sürüm henüz GitHub/Render'a gönderilmemiş ve telefona kurulmamıştı.

Eski sürümün yalnızca imzalı, hesap HMAC kanıtı olmayan izin kaydı varsa aynı
mevcut yenileme ayarı güncellenmelidir; yeni bir izin değildir. Önceki yerel izin
sürümü gerçek cihazlara kurulmamıştır.
Röle ve token değişikliğini alacak Android cihazları yeni sürüme güncellenmelidir.

Derlenen uygulama: `app/build/outputs/apk/debug/app-debug.apk`.
Test kayıtları: `backup-server-tests.txt` ve `backup-permissions-android.txt`.
