import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const file = '/Users/cigdemgokdas/Desktop/AURA/presentation/output/AURA_Juri_Sunumu_Tarayicida_Ac.html';
const browser = await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  await page.goto(pathToFileURL(file).href,{waitUntil:'load'});
  if(await page.title()!=='AURA — Türkçe Jüri Sunumu') throw new Error('wrong title');
  if(await page.locator('.slide').count()!==5) throw new Error('wrong slide count');
  await page.locator('[data-go="2"]').click();
  if(await page.locator('.slide.active').getAttribute('data-index')!=='2') throw new Error('slide navigation failed');
  await page.locator('#notesBtn').click();
  if(!await page.locator('#notes').isVisible()) throw new Error('notes failed');
  if(!await page.locator('.slide.active img').evaluate(img=>img.complete && img.naturalWidth>0)) throw new Error('image missing');
  await page.screenshot({path:'/Users/cigdemgokdas/Desktop/AURA/presentation/.build/browser-slide3.png'});
  console.log(JSON.stringify({title:await page.title(),slides:5,current:await page.locator('#counter').textContent(),notesVisible:true,imageLoaded:true}));
} finally { await browser.close(); }
