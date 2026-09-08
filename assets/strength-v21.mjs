import { L, KEYS, CATALOG_VERSION, QUESTION_MAP } from './sf-data-v21.mjs';
import { evaluate, answerRecord, DEFAULT_WEIGHTS } from './sf-engine-v21.mjs';
import { drainOutbox } from './sf-sync.mjs';
const $ = s => document.querySelector(s);
const STORE = 'sf2.deluxe.v1', PHASES = ['A','B','C','D'];
const NAMES = ['广谱筛选','定向验证','重点确认','你的预测'];
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
let vault = read(STORE), storageOk=true, conflict=false, busy=false, retryTimer, delay=2000, selected=null, shownAt=0, elapsed=0, config=null;
if (!vault || !Array.isArray(vault.sessions)) vault = { clientId: crypto.randomUUID(), activeId:null, sessions:[] };
const active = () => vault.sessions.find(s=>s.id===vault.activeId);
function status(text,error=false) { $('#sync-text').textContent=text; $('#sync-bar').classList.toggle('error',error); $('#retry').hidden=!error || conflict; }
function save() {
  if (conflict) return false;
  try { localStorage.setItem(STORE,JSON.stringify(vault)); storageOk=true; return true; }
  catch { storageOk=false; status('此设备无法保存进度，请保持页面开启；连接后仍会同步到后台。',true); return false; }
}
function addEvent(type, payload={}) {
  if (conflict) return;
  const s=active(); s.seq++;
  s.events.push({seq:s.seq,type,...payload}); save(); void flush();
}
async function request(path,body,token) {
  const response=await fetch('/api/strength'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error(data.error || '暂时无法同步'),{status:response.status});
  return data;
}
async function flush() {
  if(busy || conflict || !vault.sessions.length) return;
  busy=true; clearTimeout(retryTimer);
  try {
    await drainOutbox(vault,request,save,()=>conflict);
    delay=2000;
    if(!conflict) status(storageOk?'进度已保存 · 已同步到后台':'已同步到后台 · 此设备暂时无法保存续答记录',!storageOk);
  } catch(e) {
    if(!conflict) {
      status(e.status===409 || e.status===403 ? '同步遇到冲突：'+e.message : storageOk?'进度已保存在此设备 · 连接恢复后自动同步':'尚未同步，且无法在此设备保存。请保持页面开启并重试。',true);
      if (e.status!==409 && e.status!==403 && e.status!==400) { retryTimer=setTimeout(flush,delay); delay=Math.min(60000,delay*2); }
    }
  } finally { busy=false; }
}
function show(id) { document.querySelectorAll('.screen').forEach(el=>el.hidden=el.id!==id); window.scrollTo({top:0,behavior:'instant'}); }
function resumeLabel() {
  const s=active(); $('#resume').hidden=!s;
  if(s) $('#resume').textContent=evaluate(s.answers,s.weights).done?'查看上次结果':`继续上次 · 已答 ${s.answers.length} 题`;
}
async function begin() {
  $('#start').disabled=true; $('#start').textContent='准备你的测验…';
  try { config=await request('/config?catalogVersion=sf2.1'); }
  catch { config=read('sf2.config') || {catalogVersion:CATALOG_VERSION,version:1,weights:DEFAULT_WEIGHTS}; }
  try {
    if(config.catalogVersion!==CATALOG_VERSION) { status('题库已更新，请刷新页面后开始。',true); return; }
    try{localStorage.setItem('sf2.config',JSON.stringify(config));}catch{}
    // Keep unsent older sessions so restarting cannot silently drop their data.
    vault.sessions=vault.sessions.filter(s=>!s.created || s.events.length);
    const s={id:crypto.randomUUID(),token:crypto.randomUUID(),catalogVersion:CATALOG_VERSION,version:config.version,weights:config.weights,answers:[],events:[],seq:0,ack:0,created:false,feedback:null,startedAt:new Date().toISOString()};
    vault.sessions.push(s);vault.activeId=s.id;save();renderQuestion();resumeLabel();
  } finally { $('#start').disabled=false; $('#start').innerHTML='开始发现 <span aria-hidden="true">↗</span>'; }
}
function choose(index) {
  if(conflict)return;
  selected=index;
  document.querySelectorAll('#options .option').forEach((el,i)=>{el.classList.toggle('selected',i===index);el.setAttribute('aria-pressed',String(i===index));});
  $('#next').disabled=false;
}
function renderQuestion(restored=null) {
  const s=active(), state=evaluate(s.answers,s.weights);
  if(state.done) return renderResult();
  show('quiz');selected=null;elapsed=0;shownAt=performance.now();
  const q=state.next, pi=PHASES.indexOf(state.phase);
  $('#steps').innerHTML=PHASES.map((p,i)=>`<li class="${i===pi?'active':i<pi?'complete':''}" ${i===pi?'aria-current="step"':''}><span>${i<pi?'✓':String(i+1).padStart(2,'0')}</span><span class="step-name">${NAMES[i]}</span></li>`).join('');
  $('#phase-label').textContent=`${String(pi+1).padStart(2,'0')} / ${NAMES[pi]}`;
  $('#question-count').textContent=`第 ${state.answered+1} 题${state.phase==='D'?' · 最后一题':''}`;
  // Each stage owns a stable share of progress; adaptive totals never jump backwards.
  const progress=pi===0?state.answered/10*28:pi===1?28+s.answers.filter(a=>a.phase==='B').length/Math.max(1,KEYS.filter(k=>!s.answers.some(a=>a.phase==='A'&&a.leaf===k)).length)*42:pi===2?70+s.answers.filter(a=>a.phase==='C').length/5*25:97;
  $('#progress').value=Math.min(97,progress);$('#progress').setAttribute('aria-valuetext',`第 ${pi+1} 阶段，共 4 个阶段`);
  $('#q-kicker').textContent=state.phase==='A'?'从最不擅长的那件事开始':state.phase==='C'?'换一个角度，再确认一下':state.phase==='D'?'揭晓之前，听听你的直觉':'想想你最近的真实经历';
  $('#q-stem').textContent=q.stem;
  $('#q-help').textContent=state.phase==='A'?'选择相对最吃力的一件，不需要和别人比较。':state.phase==='D'?'选你认为最可能的结果。这一题不影响计分。':'选择最接近日常状态的答案，选好后再继续。';
  $('#options').className='options'+(state.phase==='D'?' prediction':'');
  $('#options').innerHTML=q.options.map((o,i)=>`<button class="option" aria-pressed="false" data-choice="${i}"><span class="option-key" aria-hidden="true">${i<5?'ABCDE'[i]:''}</span><span>${esc(o.text)}${state.phase==='D'?`<small>${esc(L[o.leaf].ex)}</small>`:''}</span><span class="check" aria-hidden="true">✓</span></button>`).join('');
  $('#options').querySelectorAll('button').forEach((el,i)=>el.onclick=()=>choose(i));
  $('#back').disabled=!s.answers.length;$('#next').disabled=true;$('#next').innerHTML=state.phase==='D'?'查看我的发现 <span aria-hidden="true">↗</span>':'下一题 <span aria-hidden="true">→</span>';
  addEvent('view',{questionId:q.id});
  if(restored!==null) choose(restored);
  $('#q-stem').focus({preventScroll:true});
}
function submit() {
  if(selected===null || conflict || $('#quiz').hidden)return;
  const s=active(),q=evaluate(s.answers,s.weights).next, choice=selected;
  selected=null;$('#next').disabled=true;
  const durationMs=Math.min(3600000,Math.round(elapsed+(document.hidden?0:performance.now()-shownAt)));
  s.answers.push(answerRecord(q.id,choice,durationMs));
  addEvent('answer',{questionId:q.id,choice,durationMs});
  renderQuestion();
}
function renderResult() {
  const s=active(), state=evaluate(s.answers,s.weights), win=state.ranked[0];
  if(!win)return;
  const evidence=s.answers.filter(a=>a.leaf===win.key && (a.phase==='B'||a.phase==='C'));
  const convincing=evidence.filter(a=>a.choice>=3), strong=convincing.length>0, hit=state.prediction===win.key;
  const certainty=convincing.length>=2?'两条经历相互支持':convincing.length===1?'有一条较明确的线索':'目前证据还不充分';
  const ranked=state.ranked.slice(0,8);
  $('#report').innerHTML=`<div class="result-head"><span class="eyebrow">YOUR DISCOVERY / 你的发现</span><span class="report-id">${s.answers.length} 道真实回答 · ${esc(new Date(s.startedAt).toLocaleDateString('zh-CN'))}</span></div>
  <article class="result-hero"><span class="eyebrow">${strong?(hit?'你和自己的直觉，站在了同一边':'你可能忽略的那个强项'):'一个值得继续验证的方向'}</span><h1 tabindex="-1">${esc(L[win.key].n)}</h1><div class="path">${esc(L[win.key].root)} / ${esc(L[win.key].br)} · ${esc(certainty)}</div><p>${strong?esc(L[win.key].say):'这次回答里，它相对靠前，但目前不足以认定这是你的强项。可以结合更多真实经历，再来确认。'}</p>
  <div class="evidence">${evidence.map(a=>`<blockquote>${esc(a.stem)}<strong>“${esc(a.option)}”</strong></blockquote>`).join('')}</div></article>
  <div class="result-grid"><section class="panel"><h2>你眼中的自己</h2><p>你猜的是 <b>${esc(L[state.prediction].n)}</b>。${hit?'这次结果与你的判断一致。':'这次回答指向了另一个方向，值得在生活里留意一下。'}</p><p style="margin-top:16px">结果只描述这份回答里的线索，不代表完整能力，也不是人群排名。</p></section>
  <section class="panel"><h2>这些线索，也值得留意</h2><p>按本次回答中的相对表现排序。</p><ol class="ranking">${ranked.map((r,i)=>`<li><span>${String(i+1).padStart(2,'0')}</span><div>${esc(L[r.key].n)}<div class="rank-meter" aria-hidden="true"><i style="width:${Math.max(0,Math.min(100,(r.value-2)/10*100))}%"></i></div></div><small>${r.targeted} 条经历</small></li>`).join('')}</ol></section></div>
  <section class="panel feedback-form"><h2>这份发现，像你吗？</h2><p>你的反馈会帮助我们理解题目是否表达清楚。没有标准答案。</p><div class="rating" role="group" aria-label="结果贴合程度，1 到 5 分">${[1,2,3,4,5].map(n=>`<button data-rating="${n}" aria-pressed="${s.feedback?.rating===n}" aria-label="${n} 分">${n}</button>`).join('')}</div><div class="rating-labels"><span>不太像我</span><span>很像我</span></div><label for="feedback-note" class="muted">想补充的内容（选填）</label><textarea id="feedback-note" maxlength="1000" placeholder="哪一道题让你犹豫，或者哪个发现令你意外？">${esc(s.feedback?.note||'')}</textarea><button class="button secondary" id="feedback-send" ${s.feedback?'':'disabled'}>保存反馈</button><p id="feedback-status" role="status" style="margin-top:12px">${s.feedback?'你的反馈已保存在本次记录中。':''}</p></section>
  <details><summary>了解这次测验</summary><p>题库 ${esc(s.catalogVersion)} · 权重 v${s.version}。自动校准只用于之后开始的新测验。本次使用的权重保持固定。未问到的题目不算低分。</p><p>共筛去 ${KEYS.filter(k=>state.state[k].out).length} 个候选。${KEYS.filter(k=>state.state[k].out).map(k=>esc(L[k].n)).join('、')}。</p></details>
  <div class="report-actions"><button class="button primary" id="download">保存结果</button><button class="button secondary" id="print">打印 / PDF</button><button class="button secondary" id="again">重新发现</button></div>`;
  let rating=s.feedback?.rating;
  $('#report').querySelectorAll('[data-rating]').forEach(el=>el.onclick=()=>{rating=Number(el.dataset.rating);$('#report').querySelectorAll('[data-rating]').forEach(b=>b.setAttribute('aria-pressed',String(b===el)));$('#feedback-send').disabled=false;});
  $('#feedback-send').onclick=()=>{if(!rating||conflict)return;const note=$('#feedback-note').value.trim();s.feedback={rating,note};addEvent('feedback',{rating,note});$('#feedback-status').textContent='反馈已保存，联网后会自动同步。';};
  $('#again').onclick=()=>$('#restart-dialog').showModal();
  $('#print').onclick=()=>window.print();
  $('#download').onclick=()=>{
    const content=`强项查找器 · 我的发现\n${L[win.key].n}\n${certainty}\n\n`+evidence.map(a=>`${a.stem}\n我的回答：${a.option}`).join('\n\n')+`\n\n我的预测：${L[state.prediction].n}\n题库 ${s.catalogVersion} / 权重 v${s.version}\n结果仅供自我探索，不代表人群排名。`;
    const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='我的强项发现.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  show('result');$('#report h1').focus({preventScroll:true});resumeLabel();
}
$('#start').onclick=()=>{if(active())$('#restart-dialog').showModal();else void begin();};
$('#restart-dialog').addEventListener('close',()=>{if($('#restart-dialog').returnValue==='start')void begin();});
$('#resume').onclick=()=>{if(!active()||conflict)return;addEvent('resume');renderQuestion();};
$('#next').onclick=submit;
$('#back').onclick=()=>{if(conflict)return;const s=active();if(!s.answers.length)return;const last=s.answers.pop();addEvent('back');renderQuestion(last.choice);};
$('#pause').onclick=()=>{if(conflict)return;addEvent('pause');show('intro');resumeLabel();$('#resume').focus();};
$('#retry').onclick=()=>void flush();
window.addEventListener('online',()=>void flush());
document.addEventListener('visibilitychange',()=>{
  if(!active() || $('#quiz').hidden)return;
  if(document.hidden){elapsed+=performance.now()-shownAt;addEvent('pause');}
  else{shownAt=performance.now();addEvent('resume');}
});
window.addEventListener('pagehide',()=>{if(active())save();});
window.addEventListener('storage',e=>{if(e.key===STORE && e.newValue!==JSON.stringify(vault)){conflict=true;clearTimeout(retryTimer);document.querySelectorAll('#quiz button,#start,#resume,.feedback-form button').forEach(b=>b.disabled=true);status('其他标签页已更新这份测验。请刷新此页后继续。',true);}});
document.addEventListener('keydown',e=>{
  if(e.repeat || e.ctrlKey || e.metaKey || e.altKey || $('#quiz').hidden || $('#restart-dialog').open || conflict)return;
  if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;
  if(e.key==='Enter' && selected!==null && (e.target===document.body || e.target===$('#q-stem') || e.target.closest('#options'))){e.preventDefault();submit();return;}
  const q=evaluate(active().answers,active().weights).next;
  if(q.phase==='D')return;
  const i='12345'.indexOf(e.key), letter='abcde'.indexOf(e.key.toLowerCase());
  if(e.key.length===1&&(i>=0||letter>=0)){e.preventDefault();choose(i>=0?i:letter);}
});
let theme=read('sf2.theme') || 'dark';
function applyTheme(){document.documentElement.dataset.theme=theme;$('#theme').textContent=theme==='dark'?'明亮模式':'深色模式';$('#theme').setAttribute('aria-label',theme==='dark'?'切换至明亮模式':'切换至深色模式');}
$('#theme').onclick=()=>{theme=theme==='dark'?'light':'dark';applyTheme();try{localStorage.setItem('sf2.theme',JSON.stringify(theme));}catch{}};applyTheme();
try { if(active()) evaluate(active().answers,active().weights); } catch { vault.activeId=null;status('旧进度格式无法读取，原记录已保留。可以开始一次新测验。',true); }
// Migrate the previous v2 local save through the shared replay validator.
const old=read('sf2.v1');
if(!active() && old?.log?.length && !vault.legacyImported) {
  try {
    const answers=[];
    for(const entry of old.log){const q=evaluate(answers).next;answers.push(answerRecord(q.id,entry.oi,0));}
    if(old.done)answers.push(answerRecord('predict',KEYS.indexOf(old.predict),0));
    evaluate(answers);
    const s={id:crypto.randomUUID(),token:crypto.randomUUID(),catalogVersion:CATALOG_VERSION,version:1,weights:DEFAULT_WEIGHTS,answers,events:[],seq:0,ack:0,created:false,startedAt:new Date().toISOString()};
    for(const a of answers){s.events.push({seq:++s.seq,type:'view',questionId:a.questionId});s.events.push({seq:++s.seq,type:'answer',questionId:a.questionId,choice:a.choice,durationMs:0});}
    vault.sessions.push(s);vault.activeId=s.id;vault.legacyImported=true;save();
    $('#legacy').hidden=false;$('#legacy').textContent='已恢复旧版进度。继续后会同步到后台；旧记录没有作答用时，不会纳入自动调权。';
  }catch{$('#legacy').hidden=false;$('#legacy').textContent='检测到旧版存档，已原样保留。该进度无法安全迁移，请开始一份新的测验。';}
}
resumeLabel();
// Migration waits for the user's explicit Continue action before transmitting.
if(active() && !old?.log?.length)void flush();


