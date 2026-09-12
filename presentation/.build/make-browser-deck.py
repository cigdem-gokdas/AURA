from pathlib import Path
import base64, html, json

root = Path('/Users/cigdemgokdas/Desktop/AURA/presentation')
images = [root / '.build' / f'slide-{i}.png' for i in range(1, 6)]
notes = [
    'AURA, BTC-USDT ve ETH-USDT fırsatlarını tek yönetilen risk bütçesiyle karşılaştırır. Piyasa Eleştirmeni bir işlem fikrini sorgulayabilir; sermayeyi hareket ettirme yetkisi yoktur. Son kararı deterministik Risk Motoru verir. Onay da ret de kanıt zinciriyle açıklanır.',
    'OKX Agent Trade Kit piyasa ve hesap verilerini sağlar. AURA göstergeleri hesaplar, BTC ile ETH’yi karşılaştırır. LLM yalnızca seçilen tezi eleştirir. Risk sertifikası emri veto edebilir. Belirsiz borsa sonucu kör tekrar yerine mutabakata gider.',
    'Bu slayt AURA dashboard’ından yeni alınmış gerçek ekran kesitlerini gösteriyor. BTC ve ETH değerlendirme altında, uygun kurulum yok. Piyasa Eleştirmeni ve risk sertifikası bekliyor. MCP izinde okuma çağrıları var. AURA’nın açık pozisyonu yok. Bu görüntü performans iddiası değildir.',
    'READ ve WRITE ayrı MCP süreçleri ve yetki alanlarıdır. Piyasa Eleştirmeni WRITE istemcisine erişmez. WRITE yalnızca ExecutionEngine içindir. Yönetilmeyen cüzdan varlığı AURA pozisyonu sayılmaz. Koruma veya borsa sonucu belirsizse sistem durur.',
    'AURA’nın farkı sınırları belli otonomidir. LLM yorumlar; kesin risk kuralları işlem yetkisini denetler; karar izi onayları ve retleri açıklanabilir kılar. Yeni canlı girişler, borsa tarafı koruma doğrulanana kadar kapalıdır.',
]
uris = ['data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode('ascii') for p in images]
labels = ['Ürün', 'Karar sistemi', 'Canlı dashboard görüntüsü', 'MCP ve güvenlik', 'Neden AURA']
out = root / 'output' / 'AURA_Juri_Sunumu_Tarayicida_Ac.html'
slides = '\n'.join(f'<section class="slide" data-index="{i}" aria-label="Slayt {i+1}: {html.escape(labels[i])}"><img src="{uri}" alt="{html.escape(labels[i])} slaytı"></section>' for i, uri in enumerate(uris))
buttons = '\n'.join(f'<button type="button" data-go="{i}" aria-label="{i+1}. slayta git">{i+1}</button>' for i in range(5))
page = f'''<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AURA — Türkçe Jüri Sunumu</title>
<style>
:root {{ color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: #101a16; color: #e8eee8; overflow: hidden; }}
header {{ height: 58px; padding: 0 26px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2d3b33; }}
header strong {{ letter-spacing: .04em; font-size: 15px; }}
header span {{ color: #a7b9ab; font-size: 13px; }}
main {{ height: calc(100dvh - 114px); display: grid; place-items: center; padding: 12px 24px; }}
.slide {{ display: none; width: min(100%, calc((100dvh - 140px) * 16 / 9)); max-height: 100%; aspect-ratio: 16 / 9; box-shadow: 0 12px 45px #0008; background: #f6f3ea; }}
.slide.active {{ display: block; }}
.slide img {{ display: block; width: 100%; height: 100%; object-fit: contain; }}
footer {{ height: 56px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid #2d3b33; }}
.controls, .dots {{ display: flex; align-items: center; gap: 8px; }}
button {{ color: #f2f7f2; background: #22332a; border: 1px solid #3e5a49; border-radius: 8px; min-width: 38px; min-height: 34px; cursor: pointer; font-weight: 650; }}
button:hover, button.active {{ background: #47745c; }}
#counter {{ min-width: 58px; text-align: center; font-variant-numeric: tabular-nums; }}
#notes {{ position: fixed; left: 50%; transform: translateX(-50%); bottom: 66px; width: min(780px, calc(100vw - 40px)); max-height: 45vh; overflow: auto; background: #f7f4ea; color: #1e2925; border-radius: 12px; padding: 18px 22px; box-shadow: 0 16px 50px #0009; line-height: 1.45; display: none; }}
#notes.open {{ display: block; }}
#notes h2 {{ margin: 0 0 8px; font-size: 18px; }}
#notes p {{ margin: 0; font-size: 15px; }}
@media (max-width: 700px) {{ header span, .hint {{ display: none; }} main {{ padding: 5px; }} footer {{ padding: 0 8px; }} .dots {{ gap: 3px; }} .dots button {{ min-width: 28px; }} }}
@media print {{ body {{ background: white; overflow: visible; }} header, footer, #notes {{ display: none !important; }} main {{ display: block; height: auto; padding: 0; }} .slide, .slide.active {{ display: block; width: 100%; height: auto; max-height: none; box-shadow: none; page-break-after: always; break-after: page; }} .slide img {{ width: 100%; height: auto; }} @page {{ size: 16in 9in; margin: 0; }} }}
</style>
</head>
<body>
<header><strong>AURA / JÜRİ SUNUMU</strong><span>Türkçe · gerçek AURA dashboard görüntüsü</span></header>
<main>{slides}</main>
<aside id="notes" aria-live="polite"><h2>Sunucu notu</h2><p id="noteText"></p></aside>
<footer>
  <div class="controls"><button id="prev" aria-label="Önceki slayt">◀</button><span id="counter">1 / 5</span><button id="next" aria-label="Sonraki slayt">▶</button></div>
  <div class="dots">{buttons}</div>
  <div class="controls"><span class="hint">← → gezin · N notlar · F tam ekran</span><button id="notesBtn" aria-label="Sunucu notlarını göster">Notlar</button><button id="fullBtn" aria-label="Tam ekran">⛶</button></div>
</footer>
<script>
const notes = {json.dumps(notes, ensure_ascii=False)};
const slides = [...document.querySelectorAll('.slide')];
const dots = [...document.querySelectorAll('[data-go]')];
let current = 0;
function show(n) {{ current = Math.max(0, Math.min(slides.length - 1, n)); slides.forEach((el,i) => el.classList.toggle('active', i === current)); dots.forEach((el,i) => el.classList.toggle('active', i === current)); document.getElementById('counter').textContent = `${{current + 1}} / ${{slides.length}}`; document.getElementById('noteText').textContent = notes[current]; location.hash = `slayt-${{current+1}}`; }}
document.getElementById('prev').onclick = () => show(current - 1);
document.getElementById('next').onclick = () => show(current + 1);
dots.forEach(el => el.onclick = () => show(Number(el.dataset.go)));
document.getElementById('notesBtn').onclick = () => document.getElementById('notes').classList.toggle('open');
document.getElementById('fullBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
document.addEventListener('keydown', e => {{ if (['ArrowRight','PageDown',' '].includes(e.key)) {{ e.preventDefault(); show(current+1); }} if (['ArrowLeft','PageUp'].includes(e.key)) {{ e.preventDefault(); show(current-1); }} if (e.key.toLowerCase() === 'n') document.getElementById('notes').classList.toggle('open'); if (e.key.toLowerCase() === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }});
show(Number(location.hash.match(/slayt-(\\d+)/)?.[1] || 1) - 1);
</script>
</body>
</html>'''
out.write_text(page, encoding='utf-8')
print(f'{out} ({out.stat().st_size} bytes)')
