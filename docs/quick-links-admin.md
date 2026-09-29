# Hazır siteler yönetimi

Operatör konsolundaki `/admin/quick-links` sayfası kategori ve site yönetimini,
açılış raporunu ve arama/filtreleme araçlarını bir arada sunar. Mevcut kayıt
kimlikleri, HTTPS adresleri, affiliate parametreleri, sıralama ve cihazlara
katalog yayınlama akışı korunur. Yeni bir Android sürümü gerekmez.

## Yönetim

- **Kategori ekle** ve **Site ekle** düğmeleri ilgili formlara götürür.
- Kategori kartında **Kategoriyi düzenle** ile adı ve sırası değiştirilir.
  **Siteleri gör** site listesini bu kategoriye göre filtreler.
- Site listesinde ad/alan adı/açıklama araması, kategori ve yayın durumu
  filtresi; katalog sırası, ad, dönem veya toplam açılışa göre sıralama vardır.
- **Düzenle** seçilen sitenin mevcut değerlerini ve sayaçlarını gösterir.
  Gizlemek sayaçları korur; kalıcı silmek siteyi ve sayaçlarını kaldırır.
  İçinde site bulunan kategori mevcut kurala göre silinemez.
- Panelde JavaScript, dış kaynaklı ikon veya takip kodu kullanılmaz. Formlar
  mevcut operatör ve CSRF kontrollerinden geçer.

## Sayaçlar ve tarihler

Özet: bugün, son 7 gün, bu ay ve tüm zamanlar. Rapor ayrıca son 30 gün, bu yıl
ve en fazla 366 günlük özel bir aralığı destekler. Tarih aralığının başlangıcı
ve bitişi dahil, gün sınırları UTC'dir. Grafik günlük veya aylık gruplanır;
62 günden uzun aralıklar aylık gösterilir. Aynı sayılar tablo olarak da okunabilir.
Kategori ve site başına bugün, bu ay, seçilen dönem ve tüm zamanlar gösterilir.

Telefonun mevcut `shortcut_opened` bildirimi sayılır; bir listeleme veya editör
tıklaması açılış sayılmaz. Kayıt yalnızca site kimliği, UTC gün başlangıcı ve
sayacı içerir. URL, query/affiliate parametreleri, cihaz, hesap veya kullanıcı
kimliği analitiğe yazılmaz. Bu sayı benzersiz ziyaretçi veya site içindeki sayfa
görüntüleme sayısı değildir.

Günlük kayıtlar bu sunucu sürümünün ilk başlangıcından itibaren tutulur.
Eski toplam ve son açılış zamanı korunur, geçmişin günlük dağılımı uydurulmaz.
Başlangıç zamanı panelde belirtilir; ilk gün kısmi olabilir. Kategori raporları
sitelerin mevcut kategori bağlarına göre hesaplanır: taşınan bir sitenin
sayaçları da yeni kategorisinde gösterilir.

PostgreSQL'de toplam ve günlük sayaç aynı SQL ifadesinde atomik artar.
`quick_link_opens_daily` tablosu ve analitik başlangıç bilgisi açılışta eklenir;
mevcut tablo veya kayıtların sıfırlanması gerekmez. Dosya deposu aynı verileri
durum formatı 13 ile saklar. Açılış kaydı katalog revizyonunu değiştirmez.

Canlı panelin değişmesi için güncel relay kodunun yayınlanması gerekir.
