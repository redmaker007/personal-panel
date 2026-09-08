import { L, KEYS, QA, CATALOG, QUESTION_MAP, SCREENING_PENALTY } from './sf-data.mjs';
export const DEFAULT_WEIGHTS=Object.fromEntries(KEYS.map(k=>[k,1]));
export const DELTAS=[-7,-5,-3,-1,1];
const roots=[...new Set(KEYS.map(k=>L[k].root))];
const order=Array.from({length:Math.max(...roots.map(r=>KEYS.filter(k=>L[k].root===r).length))},(_,i)=>roots.map(r=>KEYS.filter(k=>L[k].root===r)[i])).flat().filter(Boolean);

export function answerRecord(questionId,choice,durationMs=0){
  const q=QUESTION_MAP[questionId],o=q?.options[choice];
  if(!Number.isInteger(choice)||!o)throw new Error('无效选项');
  const skipped=o.scored===false;
  const affectedLeaf=q.phase==='A'?q.options[1-choice].leaf:q.phase==='D'||skipped?null:o.leaf;
  return {questionId,choice,durationMs,phase:q.phase,leaf:o.leaf,selectedLeaf:o.leaf,affectedLeaf,
    stem:q.stem,option:o.text,skipped,delta:q.phase==='A'?-SCREENING_PENALTY:q.phase==='D'||skipped?0:DELTAS[choice]};
}
// The selected A option is a relative preference. Only its counterpart receives
// a light penalty; no positive evidence is inferred from winning a comparison.
export function evaluate(answers=[],weights=DEFAULT_WEIGHTS){
  const state=Object.fromEntries(KEYS.map(k=>[k,{score:10,count:0,targeted:0,sum:0,out:false,screeningLosses:0,screeningWins:0,skipped:0}]));
  let ai=0,bi=0,ci=0,depth=null,prediction=null,phase='A',bTotal=null;
  const rankValue=k=>state[k].targeted?7+(3+state[k].sum/state[k].targeted)*(weights[k]??1):null;
  function advance(){
    if(ai<QA.length){phase='A';return QUESTION_MAP['A.'+ai];}
    bTotal??=order.filter(k=>!state[k].out).length;
    while(bi<order.length&&state[order[bi]].out)bi++;
    if(bi<order.length){phase='B';return QUESTION_MAP[order[bi]+'.0'];}
    depth??=KEYS.filter(k=>!state[k].out&&state[k].targeted===1).sort((a,b)=>rankValue(b)-rankValue(a)).slice(0,5);
    if(ci<depth.length){phase='C';return QUESTION_MAP[depth[ci]+'.1'];}
    phase='D';return prediction===null?QUESTION_MAP.predict:null;
  }
  let next=advance();
  for(const a of answers){
    if(!next||a.questionId!==next.id||!Number.isInteger(a.choice)||!next.options[a.choice])throw new Error('作答顺序或选项无效，请恢复已保存的进度。');
    const record=answerRecord(a.questionId,a.choice,a.durationMs);
    if(phase==='D')prediction=record.leaf;
    else if(phase==='A'){
      state[record.leaf].screeningWins++;
      const s=state[record.affectedLeaf];s.score+=record.delta;s.screeningLosses++;s.count++;s.out=s.score<=3;ai++;
    }else{
      const s=state[record.leaf];s.count++;
      if(record.skipped)s.skipped++;
      else{s.score+=record.delta;s.targeted++;s.sum+=record.delta;s.out=s.score<=3;}
      if(phase==='B')bi++;else ci++;
    }
    next=advance();
  }
  const ranked=KEYS.filter(k=>state[k].targeted>0).map(k=>({key:k,value:rankValue(k),...state[k]})).sort((a,b)=>b.value-a.value||b.targeted-a.targeted||b.score-a.score);
  const remaining=phase==='A'?(QA.length-ai)+order.filter(k=>!state[k].out).length+6:phase==='B'?order.slice(bi).filter(k=>!state[k].out).length+6:phase==='C'?depth.length-ci+1:next?1:0;
  return {next,phase,state,ranked,prediction,done:!next,answered:answers.length,estimatedTotal:answers.length+remaining,catalogCount:CATALOG.length,screeningCount:QA.length,bTotal,depthTotal:depth?.length??0};
}
