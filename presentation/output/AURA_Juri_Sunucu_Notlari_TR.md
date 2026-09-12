# AURA jüri sunumu — sunucu notları

Beş slaytlık sunum 3–5 dakikaya göre hazırlanmıştır. Üçüncü slayttaki görüntüler **AURA'nın çalışan dashboard'ından alınmış gerçek ekran kesitleridir**. Kesitler çekim anındaki durumu gösterir; geçmiş getiri veya canlı işlem başarısı kanıtı değildir. Dashboard'ın özgün İngilizce arayüz metinleri, görüntünün gerçekliğini korumak için değiştirilmemiştir.

## Slayt 1 — Açıklanabilir otonom alım-satım ajanı

**Amaç:** Ürün değerini ve yetki sınırını anlatmak.

**Anlatım:** “AURA, BTC-USDT ve ETH-USDT fırsatlarını tek yönetilen risk bütçesiyle karşılaştırır. Piyasa Eleştirmeni bir işlem fikrini sorgulayabilir; fakat sermayeyi hareket ettirme yetkisi yoktur. Son kararı deterministik Risk Motoru verir. Onay da ret de kanıt zinciriyle açıklanır.”

## Slayt 2 — Piyasa verisinden karara

**Amaç:** Karar hattını ve kesin risk vetosunu göstermek.

**Anlatım:** “OKX Agent Trade Kit piyasa ve hesap verilerini sağlar. AURA, EMA, ATR, ADX, spread ve emir defteri dengesizliği gibi göstergeleri hesaplar, BTC ile ETH'yi karşılaştırır. LLM yalnızca seçilen tezi eleştirir. Risk sertifikası emri veto edebilir. Belirsiz borsa sonucu kör tekrar yerine mutabakata gider.”

## Slayt 3 — Gerçek AURA dashboard'ı

**Amaç:** Canlı demo yerine ürünün gerçek arayüzünü tek bakışta göstermek.

**Anlatım:** “Sol üstte BTC ve ETH fırsat panosunu görüyoruz. Çekim anında ikisi de değerlendirme altındaydı; uygun kurulum yoktu. Sağda Piyasa Eleştirmeni ve işlem öncesi risk sertifikasının bekleyen durumu var. Sol altta gerçek OKX ATK MCP okuma çağrılarının türü, sembolü ve sonucu görünüyor. Sağ altta AURA'nın açık pozisyonu olmadığını ve açıklama alanını görüyoruz. Bu görüntü tek bir anı belgeliyor; kârlılık kanıtı olarak sunulmuyor.”

## Slayt 4 — Ayrı yetki, görünür kanıt

**Amaç:** MCP entegrasyonunu ve güvenlik sınırlarını açıklamak.

**Anlatım:** “READ ve WRITE, ayrı MCP istemcileri ve ayrı süreçlerdir. READ süreci sunucu düzeyinde salt okunurdur; Piyasa Eleştirmeni WRITE istemcisine erişmez. WRITE yetkisi yalnızca ExecutionEngine'dedir. AURA ayrıca dışarıya salt okunur Status MCP sunar. Yönetilmeyen cüzdan varlığı AURA pozisyonu sayılmaz. İşlem veya koruma durumu belirsizse sistem durur; yeni canlı BUY emirleri koruma uçtan uca doğrulanana kadar engellenmiştir.”

## Slayt 5 — Sınırları belli otonomi

**Amaç:** Ürünün farkını abartılı performans iddiası olmadan kapatmak.

**Anlatım:** “AURA'nın farkı, yapay zekâ yorumuyla işlem yetkisini birbirinden ayırmasıdır. Kesin risk kuralları sermayeyi korur; karar izi hem onayı hem reddi açıklanabilir kılar. Doğrulanmış canlı kârlılık iddiasında bulunmuyoruz. Yeni canlı girişler, borsa tarafındaki koruma güvenle doğrulanana kadar kapalıdır.”

## 45 saniyelik açılış

“AURA, OKX Agent Trade Kit üzerine kurulu açıklanabilir bir alım-satım ajanı. BTC-USDT ve ETH-USDT fırsatlarını tek bir risk bütçesi için karşılaştırıyor. Bir LLM'i Piyasa Eleştirmeni olarak kullanıyor; ancak LLM'in işlem yapma yetkisi veya kesin Risk Motoru'nu aşma yolu yok. AURA, kararın dayandığı piyasa kanıtını, riskin neden izin verdiğini veya reddettiğini ve ilgili MCP çağrılarını görünür kılıyor. Temel fikrimiz şu: yapay zekâ bir işlemi değerlendirebilir, fakat sınırsız işlem yetkisine sahip olmamalı. Borsa sonucu veya koruma belirsizse AURA tahmin yürütmek yerine durup mutabakat ister.”

## 15 saniyelik kapanış

“AURA; sınırlandırılmış yapay zekâyı, deterministik riski ve görünür karar izini bir araya getiriyor. Yapılan işlemi de reddedilen işlemi de açıklayabilmek, bu ürünün özü.”

## Üçüncü slayt için 60 saniyelik ürün turu

“Bu slayt kendi dashboard'ımızın yeni alınmış gerçek ekran kesitlerinden oluşuyor. Önce sol üstteki fırsat panosuna bakalım: BTC ve ETH birlikte izleniyor, fakat AURA aynı anda en fazla bir yönetilen pozisyona izin veriyor. Görüntü alındığında iki sembol değerlendirme altındaydı; uygun kurulum yoktu. Sağ üstte Piyasa Eleştirmeni ve risk sertifikası var; seçilmiş bir tez veya onaylanmış öneri yok. Sol alttaki MCP çağrı izi, OKX araçlarının hangi sembol için ve hangi sonuçla çağrıldığını gösteriyor. Bu kesitte yalnızca okuma çağrıları var. Sağ altta AURA'nın açık pozisyonu olmadığını ve açıklama alanını görüyoruz. Bu ekran getiri iddiası değildir. Yeni canlı girişler, borsa tarafı koruma doğrulaması tamamlanana kadar bloklu.”

## Olası 10 teknik jüri sorusu

1. **Neden yalnızca BTC ve ETH?** İki likit spot sembole aynı kuralları uyguluyor, toplam maruziyeti tek risk bütçesiyle sınırlıyoruz.
2. **LLM neden doğrudan işlem yapmıyor?** LLM eleştiri üretir; kesin veto Risk Motoru'ndadır ve LLM'in WRITE MCP istemcisi yoktur.
3. **MCP'nin rolü ne?** Ayrı OKX ATK MCP süreçleri okuma ve işlem yetkilerini ayırır. AURA ayrıca salt okunur durum bilgisini MCP üzerinden sunar.
4. **Pozisyon büyüklüğü nasıl hesaplanıyor?** Risk bütçesi, stop mesafesi ve pozisyon sınırlarıyla. LLM güven puanı büyüklüğü çarpmaz.
5. **Çift emir nasıl önleniyor?** OKX uyumlu istemci kimlikleri ve mutabakat kullanılıyor; belirsiz gönderim körlemesine tekrar edilmiyor.
6. **MCP erişimi kesilirse ne olur?** Yeni girişler durur. Gönderilmiş emrin sonucu başarısız varsayılmaz; mutabakat gerekir.
7. **LLM çalışmazsa açık pozisyon ne olur?** Yeni girişler durur; açık pozisyonun deterministik koruma kuralları LLM'den ayrı çalışır, ancak borsa bağlantısı ve doğrulanmış koruma hâlâ kritiktir.
8. **Cüzdandaki BTC/ETH nasıl sınıflandırılıyor?** Bakiye tek başına AURA sahipliği kanıtı değildir. Checkpoint veya eşleşen AURA emir/dolum kaydı gerekir.
9. **Neden tek yönetilen pozisyon?** Toplam riski sınırlar; açık ETH işlemi varken yeni BTC girişini sert risk kapısı reddeder.
10. **AURA sıradan bir botun ötesinde ne sunuyor?** Eleştirmen değerlendirmesi, risk sertifikası, karar izi, MCP çağrı izi ve açıklanabilir retler.

## Değerlendirme ölçütleriyle eşleşme

| Resmî ölçüt | En güçlü slaytlar |
|---|---|
| İşlevsel fayda ve değer — %30 | 1, 2, 3 |
| Kullanıcı deneyimi ve etkileşim — %30 | **3**, 5 |
| ATK MCP entegrasyon derinliği — %20 | 2, 3, 4 |
| Sistem güvenilirliği ve emniyeti — %10 | 2, 4 |
| Yenilik ve özgünlük — %10 | 1, 4, 5 |

**Doğruluk sınırı:** Sunumda uydurma getiri, PnL veya doldurulmuş emir yoktur. Yeni canlı girişler için borsa tarafı koruma henüz uçtan uca doğrulanmamıştır ve bu girişler engellenmektedir.
