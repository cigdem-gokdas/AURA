import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const SKILL_DIR = '/Users/cigdemgokdas/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.11809/skills/presentations';
const workspaceDir = '/Users/cigdemgokdas/Desktop/AURA/presentation';
const stagingDir = path.join(workspaceDir, '.build');
const finalPath = path.join(workspaceDir, 'output', 'AURA_Jury_Final_5_Slides_v2.pptx');
const { resolvePresentationFont, finalizePresentation } = await import(
  pathToFileURL(path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
const font = resolvePresentationFont();
const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = {
  ivory:'#F6F3EA', paper:'#FFFEFA', charcoal:'#1E2925', dark:'#16231F',
  muted:'#67736D', line:'#D9DFD5', green:'#47745C', greenLight:'#E6F0E7',
  amber:'#B47A2F', amberLight:'#F7EEDC', red:'#A8635A', redLight:'#F6E7E3',
  white:'#FFFFFF', darkLine:'#37463F', darkMuted:'#9FB1A6', darkCard:'#22332D',
};

function box(s,x,y,w,h,fill=C.paper,stroke='none',radius=false){
  return s.shapes.add({geometry:radius?'roundRect':'rect',
    position:{left:x,top:y,width:w,height:h},fill,
    line:{style:'solid',fill:stroke,width:stroke==='none'?0:1}});
}
function tx(s,text,x,y,w,h,size=20,color=C.charcoal,bold=false,align='left'){
  const shape=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},
    fill:'none',line:{style:'solid',fill:'none',width:0}});
  shape.text=text;
  shape.text.style={typeface:font,fontSize:size,color,bold,alignment:align,
    verticalAlignment:'middle',autoFit:'shrinkText'};
  return shape;
}
function pill(s,text,x,y,w,color,bg){box(s,x,y,w,28,bg,'none',true);tx(s,text,x+10,y+2,w-20,24,13,color,true,'center');}
function header(s,n,label,title,subtitle){
  s.background.fill=C.ivory;
  tx(s,`0${n}  /  ${label}`,62,38,600,24,15,C.green,true);
  tx(s,title,62,70,1138,58,42,C.charcoal,true);
  if(subtitle)tx(s,subtitle,64,125,1120,32,18,C.muted);
  box(s,62,677,1156,1,C.line);
  tx(s,'AURA  /  OKX AGENT TRADE KIT',62,684,450,18,11,C.muted,true);
  tx(s,`${n} / 5`,1130,684,86,18,11,C.muted,true,'right');
}
function notes(s,text){s.speakerNotes.textFrame.setText(text);}

// 1 — product value
{
  const s=p.slides.add();s.background.fill=C.ivory;
  tx(s,'AURA',62,48,300,42,18,C.green,true);
  tx(s,'Explainable autonomous\ntrading agent',62,113,840,140,58,C.charcoal,true);
  tx(s,'One risk budget across BTC-USDT and ETH-USDT.\nEvery action has an evidence trail and a hard risk veto.',65,287,750,72,24,C.muted);
  box(s,62,402,1156,206,C.paper,C.line,true);
  const items=[['01','COMPARE','BTC-USDT  /  ETH-USDT'],['02','CRITIQUE','Bounded Market Critic'],['03','AUTHORIZE','Deterministic Risk Engine']];
  items.forEach((v,i)=>{const x=90+i*382;
    tx(s,v[0],x,430,60,42,29,C.green,true);
    tx(s,v[1],x,486,328,25,15,C.muted,true);
    tx(s,v[2],x,521,328,43,24,C.charcoal,true);
    if(i<2)tx(s,'→',x+332,487,40,40,34,C.amber,true,'center');
  });
  tx(s,'AI can reason; it cannot directly move capital.',62,630,1100,30,22,C.charcoal,true);
  notes(s,'AURA compares BTC-USDT and ETH-USDT for one managed risk budget. A bounded Market Critic challenges the selected setup, but only the deterministic Risk Engine can authorize execution. We built the product to make both action and refusal explainable.');
}

// 2 — decision path
{
  const s=p.slides.add();header(s,2,'DECISION SYSTEM','From market evidence to action','A single opportunity is considered; each step can stop the order.');
  const stages=[
    ['OKX ATK MCP','Market, account and spot reads'],
    ['FEATURES + REGIME','EMA · ATR · ADX · spread · OBI'],
    ['OPPORTUNITY RANKING','Compare BTC and ETH'],
    ['MARKET CRITIC','Challenge the selected thesis'],
    ['RISK CERTIFICATE','Hard veto and position size'],
    ['MCP EXECUTION','ExecutionEngine only'],
    ['PROTECTION','Verify or fall back safely'],
    ['RECONCILIATION','Never guess after ambiguity'],
  ];
  stages.forEach(([name,detail],i)=>{
    const row=Math.floor(i/4),col=i%4,x=62+col*292,y=190+row*181;
    box(s,x,y,274,136,i===4?C.greenLight:C.paper,i===4?C.green:C.line,true);
    tx(s,String(i+1).padStart(2,'0'),x+18,y+14,42,30,18,i===4?C.green:C.amber,true);
    tx(s,name,x+18,y+49,236,30,18,C.charcoal,true);
    tx(s,detail,x+18,y+84,236,42,15,C.muted);
    if(col<3)tx(s,'→',x+270,y+50,24,36,26,C.green,true,'center');
  });
  box(s,62,580,1156,68,C.dark);
  tx(s,'LLM critiques',84,597,300,34,21,C.white,true);
  tx(s,'Risk Engine vetoes',448,597,365,34,21,C.white,true);
  tx(s,'Provenance explains',867,597,328,34,21,C.white,true);
  notes(s,'The OKX Agent Trade Kit supplies market and account evidence. AURA computes deterministic features and compares two liquid spot markets. The LLM is a critic, never a trader. The Risk Certificate has the final veto. Execution uses the separate write lane, and uncertainty is reconciled rather than retried blindly.');
}

// 3 — static demo substitute, consciously representative rather than a fake live screenshot
{
  const s=p.slides.add();s.background.fill=C.ivory;
  tx(s,'03  /  PRODUCT EXPERIENCE',48,29,580,22,15,C.green,true);
  tx(s,'AURA Intelligence Desk',48,61,1000,55,40,C.charcoal,true);
  tx(s,'A decision you can inspect in one glance · representative observe-only view',50,113,1120,28,17,C.muted);
  box(s,47,156,1186,506,C.dark,'none',true);
  // Dashboard masthead
  tx(s,'✳  AURA  /  INTELLIGENCE DESK',68,171,560,27,17,C.white,true);
  pill(s,'OBSERVE ONLY',799,170,133,C.greenLight,C.green);
  pill(s,'READ ✓',944,170,111,C.greenLight,C.green);
  pill(s,'STATUS MCP',1066,170,149,C.greenLight,C.green);
  box(s,66,209,1147,1,C.darkLine);

  // Left: opportunity board
  tx(s,'OPPORTUNITY BOARD',70,225,426,24,16,C.darkMuted,true);
  tx(s,'One position maximum · BTC and ETH compared each cycle',70,251,718,24,14,C.white);
  box(s,70,284,354,82,C.darkCard,C.darkLine,true);
  box(s,436,284,354,82,C.darkCard,C.darkLine,true);
  tx(s,'BTC-USDT',87,294,230,27,21,C.white,true);pill(s,'WAITING',308,297,99,C.amber,C.amberLight);
  tx(s,'No eligible setup published',87,330,300,23,14,C.darkMuted);
  tx(s,'ETH-USDT',453,294,230,27,21,C.white,true);pill(s,'WAITING',674,297,99,C.amber,C.amberLight);
  tx(s,'No eligible setup published',453,330,300,23,14,C.darkMuted);

  // Left: provenance
  box(s,70,381,720,119,C.darkCard,C.darkLine,true);
  tx(s,'DECISION PROVENANCE',88,392,340,23,16,C.darkMuted,true);
  tx(s,'Market  →  Features  →  Ranking  →  Critic  →  Risk  →  Execution',88,423,678,30,19,C.white,true);
  tx(s,'No completed cycle · every stage is recorded once published',88,465,660,22,14,C.darkMuted);

  // Left: MCP trace
  box(s,70,512,720,132,C.darkCard,C.darkLine,true);
  tx(s,'ATK MCP TRACE',88,521,330,23,16,C.darkMuted,true);
  tx(s,'READ   market_get_ticker',88,555,330,21,16,C.white);
  tx(s,'READ   spot_get_fills',88,584,330,21,16,C.white);
  tx(s,'WRITE  no order call in this state',436,555,330,21,16,C.amberLight,true);
  tx(s,'Independent stdio lanes',436,584,330,21,16,C.darkMuted);

  // Right: critic and hard certificate
  box(s,808,225,405,124,C.darkCard,C.darkLine,true);
  tx(s,'MARKET CRITIC',827,237,270,22,16,C.darkMuted,true);
  tx(s,'Awaiting selected setup',827,267,351,29,22,C.white,true);
  tx(s,'Counter-thesis appears before risk review',827,308,358,24,14,C.darkMuted);
  box(s,808,362,405,105,C.darkCard,C.darkLine,true);
  tx(s,'RISK CERTIFICATE',827,374,290,22,16,C.darkMuted,true);
  tx(s,'HOLD  /  NO PROPOSAL',827,404,357,29,23,C.amberLight,true);
  tx(s,'No authorization → no execution',827,440,350,18,14,C.darkMuted);

  // Right: position and explanation
  box(s,808,480,405,71,C.darkCard,C.darkLine,true);
  tx(s,'POSITION / PROTECTION',827,488,326,20,15,C.darkMuted,true);
  tx(s,'FLAT  ·  no AURA-managed position',827,517,355,24,17,C.white,true);
  box(s,808,564,405,80,C.darkCard,C.darkLine,true);
  tx(s,'ASK AURA  /  STATUS MCP',827,571,353,22,15,C.darkMuted,true);
  tx(s,'“Why no trade?”',827,597,300,24,19,C.white,true);
  tx(s,'No qualifying setup or risk approval',827,622,353,18,14,C.darkMuted);
  tx(s,'STATIC PRODUCT VIEW  ·  NO HISTORICAL TRADE OR PERFORMANCE CLAIMS',56,674,900,18,11,C.muted,true);
  tx(s,'3 / 5',1140,674,75,18,11,C.muted,true,'right');
  notes(s,'This slide substitutes for the live dashboard. Read it left to right: BTC and ETH are compared for one risk budget; a completed cycle would populate provenance. The Market Critic challenges a selected setup. The Risk Certificate can hold execution, and the trace shows which MCP reads contributed and whether the write lane was used. Position and protection remain explicit; Ask AURA and the read-only Status MCP explain why no trade occurred. This is a representative observe-only state, not a historical screenshot or performance result.');
}

// 4 — MCP architecture + reliability
{
  const s=p.slides.add();header(s,4,'MCP + SAFETY','Separate authority, visible evidence','AURA is an OKX ATK client and also exposes a read-only Status MCP.');
  box(s,62,187,341,289,C.paper,C.line,true);
  tx(s,'READ MCP PROCESS',86,210,290,34,27,C.charcoal,true);
  tx(s,'market  ·  account  ·  spot reads',86,257,290,30,18,C.muted);
  pill(s,'SERVER-LEVEL READ ONLY',86,319,260,C.green,C.greenLight);
  tx(s,'Market evidence and exchange truth',86,369,285,46,18,C.charcoal);
  tx(s,'→',405,296,60,60,46,C.green,true,'center');
  box(s,470,187,341,289,C.dark,'none',true);
  tx(s,'AURA',496,210,292,39,31,C.white,true);
  tx(s,'Features  →  Critic  →  Risk',496,265,287,39,20,C.white);
  box(s,493,331,296,70,C.greenLight,'none',true);
  tx(s,'RISK CERTIFICATE',507,340,275,23,17,C.green,true);
  tx(s,'Final execution veto',507,368,260,23,17,C.charcoal,true);
  tx(s,'→',815,296,60,60,46,C.green,true,'center');
  box(s,880,187,338,289,C.paper,C.line,true);
  tx(s,'WRITE MCP PROCESS',904,210,296,34,27,C.charcoal,true);
  tx(s,'spot execution only',904,257,284,30,18,C.muted);
  pill(s,'EXECUTIONENGINE ONLY',904,319,254,C.amber,C.amberLight);
  tx(s,'No LLM write access',904,369,275,42,18,C.charcoal);
  box(s,62,504,1156,136,C.greenLight,'none',true);
  tx(s,'ONE MANAGED POSITION',84,523,370,26,18,C.green,true);
  tx(s,'NO BLIND RETRY',482,523,270,26,18,C.green,true);
  tx(s,'AMBIGUITY → RECONCILE',824,523,360,26,18,C.green,true);
  tx(s,'Unmanaged wallet inventory stays separate. An LLM outage blocks entries; open-position rules remain deterministic.',84,577,1098,48,18,C.charcoal);
  notes(s,'The READ and WRITE lanes are separate MCP client processes with separate authority. The Market Critic only sees read-side evidence. The deterministic Risk Certificate gates execution. AURA also serves its own read-only status interface for outside observers. Safety rules allow one AURA-managed position, distinguish unrelated inventory, and stop under ambiguous execution or protection state. Current live entry protection remains unverified, so new live BUYs are blocked.');
}

// 5 — differentiation
{
  const s=p.slides.add();header(s,5,'WHY AURA','Explainable autonomy with limits','A trading agent earns trust by explaining the trades it refuses.');
  const blocks=[
    ['BOUNDED AI','The LLM challenges a thesis.\nIt never owns trading authority.'],
    ['DETERMINISTIC SAFETY','Hard risk rules decide whether\ncapital can be deployed.'],
    ['EXPLAINABLE AUTONOMY','Evidence, rejections and MCP calls\nremain inspectable.'],
  ];
  blocks.forEach(([title,body],i)=>{const x=62+i*390;
    box(s,x,196,370,210,i===1?C.dark:C.paper,i===1?'none':C.line,true);
    tx(s,String(i+1).padStart(2,'0'),x+24,219,80,38,26,i===1?C.greenLight:C.green,true);
    tx(s,title,x+24,266,328,33,23,i===1?C.white:C.charcoal,true);
    tx(s,body,x+24,311,324,68,17,i===1?C.darkMuted:C.muted);
  });
  box(s,62,439,1156,58,C.greenLight,'none',true);
  tx(s,'BTC + ETH  ·  OKX ATK MCP  ·  Risk Certificate  ·  Decision Provenance  ·  Read/Write isolation',82,452,1112,32,18,C.green,true,'center');
  tx(s,'AURA is designed to know when to trade, when not to trade,\nand to explain both.',62,537,1148,95,30,C.charcoal,true);
  notes(s,'AURA combines bounded AI, deterministic trade safety and decision provenance. It is an MCP-native product: not a black-box strategy. The current safety posture is deliberate. New live entries remain blocked until exchange-side protection is verified end to end. The value is not trading more; it is making market decisions that can be examined and challenged.');
}

await fs.mkdir(stagingDir,{recursive:true});
await fs.mkdir(path.dirname(finalPath),{recursive:true});
const candidatePath=path.join(stagingDir,'candidate-v2.pptx');
await (await PresentationFile.exportPptx(p)).save(candidatePath);
for(let i=0;i<p.slides.items.length;i++){
  const png=await p.export({slide:p.slides.items[i],format:'png',scale:1});
  await fs.writeFile(path.join(stagingDir,`slide-${i+1}.png`),new Uint8Array(await png.arrayBuffer()));
}
const result=await finalizePresentation({
  explicitTotalSlideCount:5,requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  workspaceDir,candidatePath,finalPath,
  pythonExecutable:'/Users/cigdemgokdas/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
  integrityValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],
  fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,
  receiptPath:path.join(stagingDir,'validation-v2.json'),
});
console.log(JSON.stringify({font,finalPath,result}));
