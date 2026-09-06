# Eşitleme güvenliği — 1.3.0

## Kullanıcıya görünen değişiklikler

- Aynı Bearer token ve OAuth kodu, bağlantının eklendiği diğer hesap cihazlarından alınabilir.
  Kaynak telefon mevcut tokenı AES-GCM ile şifreleyerek paylaşır; token yenilenmez.
  Çerez eşitlemesi gerekmez. İlk paylaşım kaynakta AI oturumu eşitlemesi gerektirir.
- Paylaşılan anahtarı alan cihaz kendi hash doğrulamasını yapar; izinler ve profil değişmez.
  Otomatik eşitleme kapalıyken karttan açıkça anahtar alınabilir. Çıkışta yerel kopya kaldırılır.
- Son sekme elle kapatılsa veya `about:blank` olsa bile AI oturumu ve anahtar kartı
  görünür kalır; yalnızca açıkça “oturumu tamamen sil” işlemi kaldırır.
- Yedek cihazdaki dokunma, gezinme ve sekme kapatma çerez boşta süresini yeniler.
  Yerel çıkış seçilen süre boyunca korunur; kalıcı yerel çıkış için oturumun çerez
  eşitlemesi kapatılmalıdır.
- Çevrimdışı eşitleme tercihi telefonda korunur; sunucuya bildirim bekliyorsa görünür.
- Parola değişiminde şifreli çerez paketlerini açan anahtar korunur ve yeni parolayla şifrelenir.
- Çerez temizliği onay ister; sonuç, çerez temizleme geri çağrısından sonra gösterilir. WebView'in desteklediği site depolama temizliği ayrıca istenir.
- Çıkış uyarısı, yedeklenmemiş yerel verilerin geri getirilemeyeceğini belirtir.
- Hesap ekranında ana cihazın durumu ve son başarılı aktarım; oturum kartında kullanım/bekleme durumu gösterilir.
- Yedek oturumda “Şimdi bulut kopyasına dön” güncel paketi ister ve kullanılan sekmelerin bırakılmasını bekler.
- Bulut çerez yedekleri eşitleme kapalıyken de listelenip onayla silinebilir. Yerel veriler korunur; seçilen bağlantıların çerez eşitlemesi kapanır.
- Tercihlerdeki isteğe bağlı hassas ayarlar kilidi her işlem için biyometri veya cihaz ekran kilidi ister. Arka plan otomasyonu etkilenmez.

## Geçiş

Önce sunucuyu, sonra Android uygulamasını güncelleyin. Parola değişimiyle anahtar
zarfı kullanılan hesaplara eski uygulamaların çerez yüklemesi reddedilir; kullanıcı
uygulamayı güncellemelidir. Tam Chromium profili, LocalStorage veya IndexedDB
aktarımı eklenmedi; bunlar hâlâ cihazda kalır.

## Cihaz gerektirmeyen kontroller

- `npm test`: HTTP hesap sınırları, yedek yönetimi, eski uygulama reddi ve dosya deposu.
- Anahtar testleri: bağlı/bağsız ve farklı hesap cihazları, kaynak çevrimdışıyken alma,
  ikinci cihazdan OAuth ile aynı tokenın teslimi, eski tokenla komut, şifreli kalıcılık,
  parola zarfı zorunluluğu, hash değişimi ve eski anahtar sürümüyle yükleme reddi.
- `gradlew :app:testDebugUnitTest`: yerel tercih önceliği, şifreli anahtar geçişi ve mevcut Android birim testleri.
- `TEST_DATABASE_URL` yalnızca geçici bir PostgreSQL veritabanına ayarlanarak
  `npm run test:postgres`: aynı senaryoların gerçek PostgreSQL sürücüsüyle çalışması;
  eşzamanlı ana cihaz seçimi/yükleme ve parola değişimi çakışmaları.

PostgreSQL testi gerçek şemayı oluşturur ve test verileri yazar. Üretim veritabanı
kullanılmamalıdır. Bu çalışma sırasında fiziksel cihaz ve biyometrik donanım testleri
kullanıcının isteğiyle yapılmadı.
