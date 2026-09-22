# Güvenlik notları — uygulanan kontroller ve kalan riskler

Bu dosya, dikey dilimde **gerçekten uygulanmış** kontrolleri ve bilinen
boşlukları kaydeder. Tasarımdaki normatif kurallar için
[`design/v0.1-design.md` §2](design/v0.1-design.md) bölümüne bakın.

## Uygulanan kontroller

| Kontrol | Nerede | Test |
|---|---|---|
| Protokol beyaz listesi (`http`/`https`) | `src/security/ssrf.ts` | `tests/unit/ssrf.test.ts` |
| URL'de kimlik bilgisi reddi | `src/security/ssrf.ts` | aynı |
| Hostname blocklist (`localhost`, `*.internal`, `*.local`, metadata) | `src/security/ssrf.ts` | aynı |
| DNS çözümü + **dönen tüm adreslerin** doğrulanması | `src/security/ssrf.ts` | aynı |
| IPv4 private/loopback/link-local/CGNAT/reserved engelleri | `src/security/ip-ranges.ts` | aynı |
| IPv6 ULA/link-local/multicast + IPv4-mapped, NAT64, 6to4 açma | `src/security/ip-ranges.ts` | aynı |
| Bütün HTTP/HTTPS kaynakların redirect zincirinin elle çözülmesi ve IP'ye sabitlenmesi | `src/security/pinned-request.ts`, `src/audit/browser.ts` | `tests/integration/subresource-ssrf.test.ts` |
| Maksimum redirect sayısı | aynı | `checks.test.ts`, `subresource-ssrf.test.ts` |
| WebSocket/service worker/popup/download engeli | `src/audit/browser.ts` | `subresource-ssrf.test.ts` |
| `robots.txt` uyumu; `Disallow: /` iken hiç sayfa açılmaması | `src/audit/robots.ts`, `run-audit.ts` | `tests/integration/audit.test.ts` |
| Download / dialog / popup / service worker kapatma | `src/audit/browser.ts` | — |
| Yalnızca viewport screenshot (full-page yasak) | `src/audit/browser.ts` | `tests/integration/checks.test.ts` |
| Artifact path traversal koruması, relative yol zorunluluğu | `src/security/artifact-path.ts` | `tests/unit/artifact-path.test.ts` |
| Non-root container kullanıcısı (`pwuser`) | `services/analyzer/Dockerfile` | — |
| Varsayılan compose'da host'a port açılmaması | `docker-compose.yml` | — |
| Artifact indirmede kök dışına çıkan yolun reddi (400) | `src/routes/artifacts.ts` | `tests/integration/artifacts.test.ts` |
| Saklama süresi dolan screenshot'ların silinmesi | `src/audit/artifact-cleanup.ts` | aynı |
| Kişi adı taşıyan e-postaların kanıta YAZILMAMASI | `src/audit/checks/site.ts` | `tests/unit/site-checks.test.ts` |

## Bulunan ve kapatılan açık

**Playwright'ın `route` handler'ı sunucu tarafı redirect hop'ları için
çağrılmıyor.** İlk implementasyonda ana çerçeve redirect'leri Chromium'a
bırakılmıştı; `302 → http://169.254.169.254/` zinciri doğrulanmadan izlendi
ve tarayıcı link-local adrese gerçekten bağlanmaya çalıştı
(`ERR_ADDRESS_UNREACHABLE`).

Çözüm: ana belge ve bütün alt kaynak istekleri Chromium ağına bırakılmıyor.
`pinned-request.ts` her redirect'i elle çözüyor, her yeni URL'nin hostname ve
bütün DNS sonuçlarını yeniden doğruluyor, ardından bağlantıyı doğrulanmış IP'ye
sabitliyor. Orijinal hostname HTTP `Host` ve TLS SNI için korunuyor. Chromium'a
yalnızca doğrulanmış son yanıt `route.fulfill()` ile veriliyor. Engellenen alt
kaynaklar `audit_pages.blocked_resources` içinde kanıt olarak tutuluyor; ana
belge ihlali audit'i durduruyor.

Regresyon kapsamı CSS, JavaScript, görsel, font, iframe, fetch/XHR, çoklu
redirect, popup ve WebSocket denemelerini içeriyor. Ayrı hedef sunucunun hit
sayacı sıfır kalıyor; güvenli public→public redirect render edilmeye devam ediyor.

İkinci açık: IPv4 aralık maskesi işaretli 32-bit taşması nedeniyle
`169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16` gibi üst yarıdaki
aralıklar hiç eşleşmiyordu — **cloud metadata adresi engellenmiyordu**.
`base` değeri artık `>>> 0` ile işaretsize çevriliyor; sınır değer testleri
eklendi.

## Ölçüm sınırları

**CLS ölçülemiyor.** Chromium, `PerformanceObserver` ile `layout-shift`
girdisi raporlamıyor: headless shell ve tam binary, Windows geliştirme makinesi
ve Linux üretim container'ı — dördünde de büyük ve belirgin bir kayma için
sonuç 0. Aynı gözlemci üzerinden LCP çalıştığı için kurulum doğrudur.
`PERF_CLS_HIGH` bu nedenle `experimental` işaretlidir ve validator (V16)
buna dayanan iddiaları reddeder. Mevcut davranış
`tests/integration/performance.test.ts` içinde sabitlenmiştir.

**Ölçüm penceresi.** LCP, navigasyon başlangıcından itibaren
`PERF_MEASURE_WINDOW_MS` (varsayılan `lcpSlowMs + 1000` = 5 sn) boyunca
izlenir. Pencere eşikten kısa olursa yavaş bir sitenin LCP'si hiç boyanmadan
ölçüm kapanır ve bulgu **sessizce kaçırılır** — ilk implementasyonda tam bu
hata vardı (1,2 sn'lik sabit bekleme, 4 sn'lik eşik). Pencere artık eşiğe
bağlıdır ve `measurement_window_ms` olarak kanıta yazılır.

## Kalan riskler

1. **Network-level defense in depth.** Uygulama doğrulama ve IP pinleme
   uygular; yine de üretimde analyzer egress'i firewall/proxy ile public
   HTTP/HTTPS hedefleriyle sınırlandırılmalı, private, link-local, metadata ve
   control-plane ağları ağ seviyesinde de reddedilmelidir.
2. **Chromium sandbox kapalı.** Container non-root (`pwuser`) çalıştığı için
   Chromium `--no-sandbox` ile başlatılır. Chromium sandbox'ını da isteyen
   kullanıcılar Playwright'ın seccomp profilini `security_opt` ile
   bağlayabilir.
3. **`SSRF_ALLOW_LOOPBACK`** yalnızca testler içindir. Yalnızca `127.0.0.0/8`
   ve `::1` açılır; `NODE_ENV=production` iken servis başlamayı reddeder.
   Yine de üretim `.env` dosyasında **hiçbir zaman** tanımlanmamalıdır.
4. **Sertifika doğrulaması render sırasında kapalıdır** (`TLS_IGNORE_ERRORS`,
   varsayılan açık). Gerekçe: süresi dolmuş sertifikası olan site tam da
   tespit edilmek istenen durumdur; katı davranılırsa audit çöker ve
   `TECH_TLS_EXPIRED` bulgusu hiç üretilemez. Analyzer sayfaya kimlik bilgisi
   veya veri göndermez, yalnızca ölçüm yapar ve sayfa içeriğini veri olarak
   ele alır. Sertifika ayrıca `tls.connect` ile doğrudan okunup bulguya
   dönüştürülür. Yine de bu, MITM edilmiş bir sayfanın ölçülebileceği
   anlamına gelir; ölçüm sonuçları buna göre yorumlanmalıdır.
5. **Domain başına hız sınırı süreç içidir.** API ve worker'lar ileride ayrı
   container'lara bölünürse bu sınır DB tabanlı bir kilide taşınmalıdır.
