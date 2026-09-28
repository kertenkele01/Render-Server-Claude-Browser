# Google Play Plus kurulumu

Uygulamadaki satın alma akışı hazırdır; gerçek ödeme alabilmesi için Play
Console ve sunucu tarafında aşağıdaki tek seferlik kurulum yapılmalıdır.

## Ürün modeli

- Paket adı: `com.kertenkele.tabrove`
- Plus abonelik ürün kimliği: `tabrove_plus`
- Plus temel planları: `monthly` (P1M) ve `yearly` (P1Y).
- Ayrı Pro ürünü `tabrove_pro` şimdilik uygulamada satışa bağlı değildir;
  Pro sayfasında “Yakında” gösterilir. Pro satın alımları Plus olarak doğrulanmaz.
- Free ve Plus arasındaki tek farklar günlük komut, hesaba bağlı cihaz ve yeni
  AI bağlantısı sınırlarıdır. Güvenlik izinleri ve diğer ürün özellikleri her
  iki planda da aynıdır.

Ürün ve temel planlar Play Console'da etkinleştirilmelidir. Fiyat ve dönem
uygulamaya Play tarafından gelir; uygulamada sabit fiyat bulunmaz.

## Yönetici tarafından süreli plan atama

Admin panelinde **Kullanıcılar → Yönet → Plan Yönetimi** üzerinden Free, Plus
veya Pro atanabilir. Süre için **Sınırsız**, **Gün**, **Ay** ya da **Yıl** seçilir;
süreli seçimlerde adet girilir (örneğin 7 gün, 3 ay veya 1 yıl). Kaydetme yeni
süreyi o andan başlatır; eski sürenin üstüne eklemez. Ay ve yıl takvim süresidir,
UTC üzerinden hesaplanır ve ay sonu gerekirse son geçerli güne yuvarlanır.
Bitiş tarihi panelde Türkiye saatiyle gösterilir.

Süre dolunca manuel ücretli hak sona erer. Aktif Google Play aboneliği varsa
Plus erişimi korunur, yoksa Free limitleri uygulanır. Free ataması aktif Play
aboneliğini iptal etmez. Cihazlar, AI bağlantıları ve yedekler silinmez; Free
limitini aşan bağlantılar mevcut seçim akışıyla duraklatılır. Sınırsız atamaların
bitiş tarihi yoktur; mevcut süresiz manuel üyelikler de aynı şekilde korunur.
Plan ve son kullanma tarihi birlikte PostgreSQL'de veya yerel dosya deposunda
saklanır. Sunucu kapalıyken biten süre açılışta da geçerli olmaz.

## Play Console'da satışa açma

1. Play Console'da **Ayarlar → Ödemeler profili** bölümünü tamamlayın.
2. Gerçek yükleme anahtarıyla imzalanmış `com.kertenkele.tabrove` uygulama
   paketini bir iç test sürümüne yükleyin. Projedeki debug anahtarıyla alınmış
   yedek release derlemesini dağıtım için kullanmayın. İlk kez oluştururken
   `scripts/create-play-upload-key.ps1`, sonraki paketler için
   `scripts/build-play-bundle.ps1` kullanılabilir. `my-upload-key.jks` ve
   `.upload-key-password.txt` dosyalarını birlikte güvenli bir yere yedekleyin;
   bunlar depoya eklenmez. Yüklenecek dosya
   `app/build/outputs/bundle/release/app-release.aab` konumundadır.
3. **Google Play ile para kazanma → Ürünler → Abonelikler** bölümünde
   `tabrove_plus` kimlikli aboneliği kullanın. Kullanıcıya görünen adı
   `Tabrove Plus` olmalıdır. Sunucuda `GOOGLE_PLAY_PLUS_SUBSCRIPTION_ID=tabrove_plus`
   ve `GOOGLE_PLAY_PRO_SUBSCRIPTION_ID=tabrove_pro` değerlerini kullanıp güncel
   sunucu sürümünü yayınlayın. Eski ortak `GOOGLE_PLAY_SUBSCRIPTION_ID` ayarı
   artık kullanılmaz. Aynı servis hesabı JSON anahtarı iki ürün için de kullanılır;
   yeni abonelik oluşturmak yeni bir servis hesabı anahtarı gerektirmez.
4. Bu aboneliğin altında `monthly` (aylık) ve `yearly` (yıllık) otomatik
   yenilenen temel planları oluşturun; satılacak ülkeleri ve fiyatları seçip
   planları etkinleştirin.
5. Sunucu kimliğini ve gerçek zamanlı bildirimleri aşağıdaki gibi kurun.
   Bunlar tamamlanmadan uygulama satın alma seçeneklerini göstermez veya
   satın almayı Plus erişimine dönüştürmez.

## Sunucu kimliği

1. Google Cloud projesinde Google Play Android Developer API'yi etkinleştirin.
2. Yalnızca bu iş için bir servis hesabı oluşturun ve Play Console'daki ilgili
   uygulamaya ekleyin.
3. Hesaba abonelikleri okuyup yönetmeye yetecek en dar Play izinlerini verin:
   sipariş/abonelikleri görüntüleme ile sipariş ve abonelikleri yönetme.
4. JSON anahtarını kaynak koduna eklemeyin. Dağıtım platformunda gizli dosya
   olarak tutup `GOOGLE_APPLICATION_CREDENTIALS` ile yolunu verin.
5. Üretimde mutlaka `DATABASE_URL` kullanın. Satın alma sahipliği ve bildirim
   tekilleştirmesi geçici JSON depoya bırakılmamalıdır.

Gerekli değişkenlerin örnekleri `.env.example` içindedir. Sunucu hesabı yalnızca
Play API'sine erişir; servis hesabı anahtarı Android uygulamasına konmaz.

## Gerçek zamanlı bildirimler

1. Bir Pub/Sub konusu oluşturun ve Google Play'in bildirim servis hesabına
   konuya yayınlama yetkisi verin.
2. Play Console'da bu konuyu Real-time developer notifications için seçin.
3. Rölede şu adrese authenticated push yapan bir Pub/Sub aboneliği oluşturun:
   `https://SUNUCU-ADRESI/api/v1/billing/google-play/rtdn`
4. Push aboneliğine özel bir servis hesabı bağlayın. Yapılandırılan audience
   değerini `GOOGLE_PLAY_RTDN_AUDIENCE`, bu hesabın e-posta adresini
   `GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT` olarak ayarlayın.

Röle gelen kimlik jetonunun imzasını, audience değerini ve servis hesabını
doğrular. Bildirim kaybolsa bile kayıtlı abonelikler belirli aralıklarla Play
üzerinden tekrar doğrulanır.

## Yayın öncesi test

1. Uygulamayı Play Console iç test kanalına yükleyin.
2. Test hesaplarını lisans testçisi ve iç test kullanıcısı yapın.
3. Aylık ve yıllık temel plan için satın alma, bekleyen ödeme, iptal, yenileme,
   geri yükleme ve süre bitimi senaryolarını deneyin.
4. Aynı satın alma jetonunun farklı bir uygulama hesabına bağlanamadığını ve
   iptal/süre bitiminden sonra Free sınırlarının döndüğünü doğrulayın.

Satın alma yalnızca Google Play sunucusunda doğrulandıktan sonra Plus'ı açar.
İstemcideki “satın alındı” sonucu tek başına yetki vermez; ilk satın almayı röle
onaylar, yenileme ve iptalleri Play bildirimleriyle izler.
