# Google Play Pro kurulumu

Uygulamadaki satın alma akışı hazırdır; gerçek ödeme alabilmesi için Play
Console ve sunucu tarafında aşağıdaki tek seferlik kurulum yapılmalıdır.

## Ürün modeli

- Paket adı: `com.kertenkele.tabrove`
- Abonelik ürün kimliği: `tabrove_pro`
- Aynı abonelik altında önerilen iki temel plan: `monthly` ve `yearly`
- Free ve Pro arasındaki tek farklar günlük komut, hesaba bağlı cihaz ve yeni
  AI bağlantısı sınırlarıdır. Güvenlik izinleri ve diğer ürün özellikleri her
  iki planda da aynıdır.

Ürün ve temel planlar Play Console'da etkinleştirilmelidir. Fiyat ve dönem
uygulamaya Play tarafından gelir; uygulamada sabit fiyat bulunmaz.

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
   `tabrove_pro` kimlikli aboneliği oluşturun. Kullanıcıya görünen adı
   `Tabrove Pro` olabilir.
4. Bu aboneliğin altında `monthly` (aylık) ve `yearly` (yıllık) otomatik
   yenilenen temel planları oluşturun; satılacak ülkeleri ve fiyatları seçip
   planları etkinleştirin.
5. Sunucu kimliğini ve gerçek zamanlı bildirimleri aşağıdaki gibi kurun.
   Bunlar tamamlanmadan uygulama satın alma seçeneklerini göstermez veya
   satın almayı Pro yetkisine dönüştürmez.

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

Satın alma yalnızca Google Play sunucusunda doğrulandıktan sonra Pro'yu açar.
İstemcideki “satın alındı” sonucu tek başına yetki vermez; ilk satın almayı röle
onaylar, yenileme ve iptalleri Play bildirimleriyle izler.
