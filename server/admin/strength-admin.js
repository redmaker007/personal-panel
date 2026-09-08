import { api, mountNav } from './app.js';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=null,page=0,sessions=[],detail=null,rollbackId=null;
const say=text=>$('#message').textContent=text;
const endpoint=(path,options)=>api('/strength-admin'+path,options);
const mutation=(path,body,method='POST')=>endpoint(path,{method,body:JSON.stringify(body||{})});
function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
mountNav('/admin/');
async function load(){
  $('#refresh').disabled=true;
  try{
    const selectedCatalog=$('#catalog-version').value;
    data=await endpoint('/summary'+(selectedCatalog?'?catalogVersion='+encodeURIComponent(selectedCatalog):''));
    $('#catalog-version').innerHTML=data.catalogVersions.map(v=>`<option value="${esc(v)}" ${v===data.catalogVersion?'selected':''}>${esc(v)}${v===data.currentCatalogVersion?' · 当前题库':' · 历史题库'}</option>`).join('');
    const s=data.sessions;
    $('#metrics').innerHTML=[['开始测验',s.total,'份匿名测验'],['完成测验',s.completed,s.total?`完成率 ${(s.completed/s.total*100).toFixed(1)}%`:'等待第一份完成记录'],['当前答案',data.answers,`${data.questions.length} 道题完整覆盖`],['结果反馈',s.feedback===null?'—':s.feedback.toFixed(1)+'/5','只用于观察，不作为训练标签']].map(([k,v,n])=>`<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><small>${esc(n)}</small></div>`).join('');
    $('#calibration-status').textContent=`${data.autoEnabled?'运行中':'已暂停'} · 当前 v${data.version} · ${data.lastAnalysis?'上次分析 '+new Date(data.lastAnalysis.at).toLocaleString('zh-CN'):'等待完成记录触发首次分析'}`;
    const historical=data.catalogVersion!==data.currentCatalogVersion;
    $('#toggle-auto').disabled=historical;$('#analyze').disabled=historical;$('#toggle-auto').textContent=historical?'历史题库仅查看':data.autoEnabled?'暂停自动调权':'开启自动调权';
    $('#weight-rows').innerHTML=data.analysis.map(r=>`<tr><td>${esc(r.name)} <small>${r.key}</small></td><td>${r.pairs}</td><td>${r.excluded}</td><td>${r.correlation===null?'—':r.correlation.toFixed(3)}</td><td>${r.current.toFixed(4)}</td><td>${r.proposed.toFixed(4)}</td><td>${esc(r.reason)}</td></tr>`).join('');
    $('#version-rows').innerHTML=data.versions.map(v=>`<tr><td>v${v.id}${v.id===data.version?' · 当前':''}</td><td>${esc(v.created_at)}</td><td>${esc(v.reason)}</td><td><button data-rollback="${v.id}" ${v.id===data.version||historical?'disabled':''}>回滚至此版本</button></td></tr>`).join('');
    document.querySelectorAll('[data-rollback]').forEach(b=>b.onclick=()=>{rollbackId=Number(b.dataset.rollback);$('#rollback-text').textContent=`将创建一个恢复 v${rollbackId} 权重的新版本，并暂停自动调权。正在进行的测验不受影响。`;$('#rollback-dialog').showModal();});
    renderQuestions();await loadSessions();say(s.total?'数据已更新。':'尚无作答数据。题库已就绪，用户开始答题后将自动显示统计。');
  }catch(e){say('数据读取失败：'+e.message);}finally{$('#refresh').disabled=false;}
}
function renderQuestions(){if(!data)return;const query=$('#search').value.trim().toLowerCase(),phase=$('#phase').value;
  const rows=data.questions.filter(q=>(!phase||q.phase===phase)&&(!query||(q.id+' '+q.stem+' '+q.options.map(o=>o.leaf).join(' ')).toLowerCase().includes(query)));
  $('#question-list').innerHTML=rows.length?rows.map(q=>`<details class="question-stat"><summary><span class="q-id">${esc(q.id)}</span><span>${q.scene ? esc(q.scene) + ' · ' : ''}${esc(q.stem)}</span></summary><div class="q-metrics"><span>展示 <b>${q.shown}</b></span><span>已答 <b>${q.answered}</b></span><span>暂不判断 <b>${q.skipped || 0}</b></span><span>未展示 <b>${q.neverShown}</b></span><span>展示未答 <b>${q.unanswered}</b></span><span>返回修改 <b>${q.revisions}</b></span><span>平均用时 <b>${q.averageMs===null?'—':(q.averageMs/1000).toFixed(1)+' 秒'}</b></span></div><div class="choice-distribution">${q.choices.map(o=>{const p=q.answered?o.count/q.answered*100:0;return `<div class="choice-row"><span>${esc(o.text)}</span><progress value="${p}" max="100" aria-label="该选项占 ${p.toFixed(1)}%"></progress><small>${o.count} 次 · ${p.toFixed(0)}%</small></div>`;}).join('')}</div></details>`).join(''):'<div class="empty">没有匹配的题目。</div>';
}
async function loadSessions(){sessions=await endpoint(`/sessions?limit=25&offset=${page*25}&catalogVersion=${encodeURIComponent(data.catalogVersion)}`);$('#session-rows').innerHTML=sessions.length?sessions.map(s=>`<tr><td>${esc(s.created_at)} <small>UTC</small></td><td>${({active:'进行中',paused:'已暂停',completed:'已完成'})[s.status]||esc(s.status)}</td><td>${s.answers.length}</td><td>v${s.weight_version}</td><td>${s.feedback??'—'}</td><td><button data-session="${esc(s.id)}">查看完整记录</button></td></tr>`).join(''):'<tr><td colspan="6">暂无记录。</td></tr>';
  $('#page-label').textContent=`第 ${page+1} 页`;$('#prev-page').disabled=page===0;$('#next-page').disabled=sessions.length<25;
  document.querySelectorAll('[data-session]').forEach(b=>b.onclick=async()=>{try{detail=await endpoint('/sessions/'+b.dataset.session);$('#detail-content').textContent=JSON.stringify(detail,null,2);$('#detail-dialog').showModal();}catch(e){say(e.message);}});
}
async function action(button,fn){button.disabled=true;try{const result=await fn();await load();say(result.reason||'设置已保存。');}catch(e){say('操作失败：'+e.message);}finally{button.disabled=false;}}
$('#refresh').onclick=load;$('#search').oninput=renderQuestions;$('#phase').onchange=renderQuestions;
$('#catalog-version').onchange=()=>{page=0;void load();};
$('#toggle-auto').onclick=e=>action(e.currentTarget,()=>mutation('/automatic',{enabled:!data.autoEnabled},'PUT'));
$('#analyze').onclick=e=>action(e.currentTarget,()=>mutation('/analyze'));
$('#rollback-dialog').addEventListener('close',()=>{if($('#rollback-dialog').returnValue==='confirm')void action($('#refresh'),()=>mutation('/rollback',{version:rollbackId}));});
$('#export-summary').onclick=()=>{if(data)download('强项题目统计.json',{exportedAt:new Date().toISOString(),questions:data.questions,analysis:data.analysis,version:data.version});};
$('#export-sessions').onclick=()=>download('强项作答记录-第'+(page+1)+'页.json',sessions);
$('#export-detail').onclick=()=>{if(detail)download('完整作答记录-'+detail.id+'.json',detail);};
$('#close-detail').onclick=()=>$('#detail-dialog').close();
$('#prev-page').onclick=async()=>{page=Math.max(0,page-1);try{await loadSessions();}catch(e){say(e.message);}};
$('#next-page').onclick=async()=>{page++;try{await loadSessions();}catch(e){say(e.message);}};
const tabs=[...document.querySelectorAll('[role=tab]')];
function tabActivate(tab){tabs.forEach(b=>{const on=b===tab;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;$('#'+b.dataset.panel).hidden=!on;});}
tabs.forEach((b,i)=>{b.onclick=()=>tabActivate(b);b.onkeydown=e=>{let index;if(e.key==='ArrowRight')index=(i+1)%tabs.length;if(e.key==='ArrowLeft')index=(i+tabs.length-1)%tabs.length;if(e.key==='Home')index=0;if(e.key==='End')index=tabs.length-1;if(index!==undefined){e.preventDefault();tabActivate(tabs[index]);tabs[index].focus();}};});
void load();

