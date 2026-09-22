# Bulgu kodları

> Bu dosya `services/analyzer/src/findings/catalog.ts` dosyasından üretilir.
> Elle düzenlemeyin; `npm run docs:findings` ile yeniden üretin.

**Kapsam:** `sayfa` bulguları her taranan sayfa için ayrı değerlendirilir.
`site` bulguları taranan tüm sayfaların toplamı üzerinden bir kez üretilir —
"iletişim formu yok" gibi yokluk bulguları tek sayfaya bakılarak verilemez.

**Outreach:** yalnızca `stable` kodlar e-posta taslağında iddia olarak
kullanılabilir. `experimental` kodlar kaydedilir ve insana gösterilir ama
validator (V16) bunlara dayanan iddiaları reddeder.

## MOBILE

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `MOB_NO_VIEWPORT` | sayfa | high | observed | stable | evet | Mobil viewport meta etiketi yok veya width tanımlamıyor |
| `MOB_HORIZONTAL_OVERFLOW` | sayfa | high | observed | stable | evet | Sayfa 375px genişlikte yatay olarak taşıyor |
| `MOB_TAP_TARGET_SMALL` | sayfa | medium | observed | stable | evet | Parmakla dokunulamayacak kadar küçük (44px altı) tıklanabilir alanlar var |
| `MOB_FORM_FIELD_OVERFLOW` | sayfa | high | observed | stable | evet | Form alanı mobil ekranın dışına taşıyor |
| `MOB_TEXT_TOO_SMALL` | sayfa | medium | observed | stable | evet | Metnin önemli bölümü mobilde 12px altında |
| `MOB_FIXED_WIDTH_LAYOUT` | sayfa | medium | observed | stable | evet | Sayfa sabit masaüstü genişliğinde (980px+) kurgulanmış |

## TECH

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `TECH_NO_HTTPS` | site | high | observed | stable | evet | Site HTTPS üzerinden sunulmuyor |
| `TECH_TLS_EXPIRED` | site | high | observed | stable | evet | SSL sertifikasının süresi dolmuş |
| `TECH_TLS_EXPIRING_SOON` | site | medium | observed | stable | evet | SSL sertifikasının süresi 21 günden az kaldı |
| `TECH_MIXED_CONTENT` | sayfa | high | observed | stable | evet | HTTPS sayfada güvensiz (http://) kaynak yükleniyor |
| `TECH_DOCUMENT_WRITE` | sayfa | low | observed | stable | evet | Sayfa document.write() kullanıyor |
| `TECH_JQUERY_OUTDATED` | sayfa | low | observed | stable | evet | Eski jQuery sürümü (3.x öncesi) kullanılıyor |
| `TECH_TABLE_LAYOUT` | sayfa | medium | observed | stable | evet | Sayfa yerleşimi iç içe tablolarla kurulmuş |
| `TECH_LEGACY_PLUGIN` | sayfa | medium | observed | stable | evet | Artık desteklenmeyen eklenti içeriği (Flash/Silverlight) var |

## PERF

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `PERF_TTFB_SLOW` | site | medium | observed | stable | evet | Sunucu ilk yanıtı yavaş (TTFB 800 ms üzeri) |
| `PERF_LCP_SLOW` | site | high | observed | stable | evet | Ana içerik mobilde geç görünüyor (LCP 4 saniye üzeri) |
| `PERF_CLS_HIGH` | site | medium | observed | experimental | hayır | Sayfa yüklenirken içerik kayıyor (CLS 0.25 üzeri) — ölçüm doğrulanamadı |
| `PERF_PAGE_WEIGHT_HIGH` | site | medium | observed | stable | evet | Sayfa ağırlığı mobil bağlantı için yüksek (3 MB üzeri) |

## SEO

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `SEO_MISSING_TITLE` | sayfa | high | observed | stable | evet | Sayfa başlığı (title) yok veya 10 karakterden kısa |
| `SEO_MISSING_DESCRIPTION` | sayfa | medium | observed | stable | evet | Meta description yok veya 40 karakterden kısa |
| `SEO_MISSING_H1` | sayfa | low | observed | stable | evet | Sayfada h1 başlığı yok |

## CONV

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `CONV_NO_CONTACT_FORM` | site | high | observed | stable | evet | Taranan sayfaların hiçbirinde iletişim formu yok |
| `CONV_NO_TEL_LINK` | site | medium | observed | stable | evet | Tıklanabilir telefon bağlantısı (tel:) yok |
| `CONV_NO_WHATSAPP_LINK` | site | low | observed | stable | evet | WhatsApp bağlantısı yok |
| `CONV_NO_BOOKING_LINK` | site | medium | observed | stable | evet | Online randevu/rezervasyon bağlantısı yok |

## CONTACT

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `CONTACT_ROLE_EMAIL_FOUND` | site | low | observed | stable | evet | Kurumsal (rol tabanlı) e-posta adresi bulundu |
| `CONTACT_NO_EMAIL_FOUND` | site | high | observed | stable | evet | Taranan sayfalarda kurumsal e-posta adresi bulunamadı |

## INF

| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |
|---|---|---|---|---|---|---|
| `INF_NO_ONLINE_APPOINTMENT` | site | medium | inferred | stable | evet | Online randevu alma yolu görünmüyor (form da randevu bağlantısı da yok) |

Toplam 28 kod.
