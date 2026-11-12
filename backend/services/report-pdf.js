const PDFDocument=require('pdfkit');
const fs=require('fs'),path=require('path');
const reportPdfCache=new Map();
function reportPdfCacheGet(key){const hit=reportPdfCache.get(key);if(!hit)return null;if(hit.expires<=Date.now()){reportPdfCache.delete(key);return null;}return hit.value;}
function invalidateReportPdfCache(){ reportPdfCache.clear(); }
function reportPdfCachePut(key,value){reportPdfCache.set(key,{value,expires:Date.now()+30000});if(reportPdfCache.size>96){const first=reportPdfCache.keys().next().value;if(first)reportPdfCache.delete(first);}}
const {source:assetSource}=require('./assets');
const safe=s=>String(s??'').replace(/[<>]/g,'');
function assetPath(url){return assetSource(url);}
function normalizeReport(input){
  const r=(input&&typeof input==='object')?input:{};
  return {
    ...r,
    subjects:(Array.isArray(r.subjects)?r.subjects:[]).map(s=>({
      ...s,
      terms:(s&&s.terms&&typeof s.terms==='object')?s.terms:{},
      assessments:Array.isArray(s?.assessments)?s.assessments:[]
    })),
    term_reports:Array.isArray(r.term_reports)?r.term_reports.filter(Boolean):[],
    report_kind:String(r.report_kind||'').toUpperCase()==='ANNUAL'?'ANNUAL':'TERM',
    exam_columns:Array.isArray(r.exam_columns)?r.exam_columns:[],
    grading_bands:Array.isArray(r.grading_bands)?r.grading_bands:[],
    subject_ranking:Array.isArray(r.subject_ranking)?r.subject_ranking:[],
    report_template_config:(r.report_template_config&&typeof r.report_template_config==='object')?r.report_template_config:{},
    pathway_guidance:(r.pathway_guidance&&typeof r.pathway_guidance==='object')?r.pathway_guidance:{}
  };
}
function hex(c,fallback){const v=String(c||'').toUpperCase();if(v==='#17365D')return '#0B4F8A';if(v==='#D9A441')return '#16A36A';return /^#[0-9A-F]{6}$/i.test(v)?v:fallback;}
function rounded(doc,x,y,w,h,r,fill,stroke){if(fill)doc.fillColor(fill).roundedRect(x,y,w,h,r).fill();if(stroke)doc.strokeColor(stroke).lineWidth(.95).roundedRect(x,y,w,h,r).stroke();}
function text(doc,t,x,y,w,size,bold,color,align='left',opts={}){doc.fillColor(color||'#222').font(bold?'Helvetica-Bold':'Helvetica').fontSize(size||7).text(safe(t),x,y,{width:w,align,lineGap:0,ellipsis:!!opts.ellipsis,height:opts.height,lineBreak:opts.lineBreak!==false});}
function line(doc,x1,y1,x2,y2,c='#111111',lw=.9){doc.save().strokeColor(c).lineWidth(lw).moveTo(x1,y1).lineTo(x2,y2).stroke().restore();}
function stars(doc,x,y,w,h,color){doc.save().strokeColor(color).lineWidth(1.25).roundedRect(x,y,w,h,7).stroke();doc.font('Helvetica-Bold').fontSize(7).fillColor(color);for(let xx=x+7;xx<x+w-5;xx+=15){doc.text('★',xx,y-1,{width:9});doc.text('★',xx,y+h-8,{width:9});}for(let yy=y+12;yy<y+h-8;yy+=15){doc.text('★',x-2,yy,{width:9});doc.text('★',x+w-5,yy,{width:9});}doc.restore();}
function drawLogo(doc,url,cx,y,size){const p=assetPath(url);if(!p)return false;try{doc.image(p,cx-size/2,y,{fit:[size,size],align:'center',valign:'center'});return true;}catch{return false;}}
function drawWatermark(doc,url,cx,cy,size,opacity=.075){const p=assetPath(url);if(!p)return false;try{doc.save().opacity(opacity);doc.image(p,cx-size/2,cy-size/2,{fit:[size,size],align:'center',valign:'center'});doc.restore();return true;}catch{try{doc.restore();}catch{}return false;}}
function drawTextWatermark(doc,name,motto,cx,cy,width,opacity=.045){const title=String(name||'').trim();if(!title)return false;try{doc.save().opacity(opacity).fillColor('#334155').font('Helvetica-Bold').fontSize(34).text(title,cx-width/2,cy-20,{width,align:'center',lineBreak:false,ellipsis:true});if(motto){doc.font('Helvetica').fontSize(13).text(String(motto),cx-width/2,cy+22,{width,align:'center',lineBreak:false,ellipsis:true});}doc.restore();return true;}catch{try{doc.restore();}catch{}return false;}}
function drawPhoto(doc,url,x,y,w,h,border){const p=assetPath(url);rounded(doc,x,y,w,h,4,'#F1F4F7',border);if(p){try{doc.image(p,x+3,y+3,{fit:[w-6,h-6],align:'center',valign:'center'});}catch{}}else{text(doc,'PASSPORT',x,y+h/2-4,w,6,true,'#94a3b8','center');}}
function fmt(v){const n=Number(v);return Number.isFinite(n)?(Math.abs(n-Math.round(n))<0.00001?String(Math.round(n)):n.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')):'—';}
function fmtDate(v){if(!v)return '—';const d=v instanceof Date?v:new Date(v);if(Number.isNaN(d.getTime()))return String(v).replace(/\s+GMT.*$/,'');return `${String(d.getUTCDate()).padStart(2,'0')} ${d.toLocaleString('en-GB',{month:'short',timeZone:'UTC'})} ${d.getUTCFullYear()}`;}
function gradeColor(g){const s=String(g||'').toUpperCase();if(['EE','A','A+'].includes(s))return '#15803d';if(['ME','B','B+','B-'].includes(s))return '#2563eb';if(['AE','C','C+','C-'].includes(s))return '#d97706';if(['BE','D','D-','E'].includes(s))return '#dc2626';return '#26384A';}
function designationColor(d){const s=String(d||'').toUpperCase();if(s==='DISTINCTION')return '#15803d';if(['MERIT','CREDIT'].includes(s))return '#2563eb';if(s==='PASS')return '#d97706';if(['AT_RISK','INCOMPLETE'].includes(s))return '#dc2626';return '#6b7280';}
function drawMiniTrend(doc,values,x,y,w,h,primary,label){text(doc,label,x,y-11,w,6.5,true,primary);rounded(doc,x,y,w,h,5,'#F1F4F7','#111111');const vals=values.filter(v=>v!=null).map(Number);if(!vals.length){text(doc,'No assessed marks yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}const pts=vals.map((v,i)=>{const px=x+12+(w-24)*(i/Math.max(1,vals.length-1));const py=y+h-11-(Math.max(0,Math.min(100,v))/100)*(h-22);return [px,py];});for(let i=1;i<pts.length;i++)line(doc,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],primary,1.4);pts.forEach((p,i)=>{doc.save().fillColor(primary).circle(p[0],p[1],2.2).fill();doc.restore();text(doc,String(Math.round(vals[i])),p[0]-8,p[1]-10,16,4.4,true,primary,'center');});}
function drawSubjectTrend(doc,report,x,y,w,h,primary,label){
 text(doc,label,x,y-11,w,6.5,true,primary); rounded(doc,x,y,w,h,5,'#F8FAFC','#111111');
 const isAnnual=report.report_kind==='ANNUAL';
 const subjects=(report.subjects||[]).filter(s=>s && (isAnnual ? Object.values(s.terms||{}).some(v=>v!=null) : (s.assessments||[]).some(a=>a.percent!=null))).slice(0,10);
 if(!subjects.length){text(doc,'No subject trend data yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}
 const palette=['#2563EB','#DC2626','#059669','#D97706','#7C3AED','#DB2777','#0891B2','#65A30D','#EA580C','#4F46E5'];
 const labels=isAnnual?['TERM 1','TERM 2','TERM 3']:((report.exam_columns||[]).map(a=>a.name||a.type));
 const left=35,right=12,top=18,bottom=20,cw=Math.max(1,w-left-right),ch=Math.max(1,h-top-bottom);
 [0,25,50,75,100].forEach(v=>{const py=y+top+ch-(v/100)*ch;line(doc,x+left,py,x+w-right,py,'#D9E1E8',.55);text(doc,String(v),x+3,py-2,27,4.2,false,'#64748B','right');});
 labels.forEach((lab,i)=>{const px=x+left+cw*(i/Math.max(1,labels.length-1));text(doc,lab,px-25,y+h-13,50,4.1,false,'#475569','center',{ellipsis:true,height:8,lineBreak:false});});
 subjects.forEach((sub,si)=>{
   const vals=isAnnual ? labels.map((_,i)=>sub.terms?.[i+1]??null) : labels.map(lab=>{const a=(sub.assessments||[]).find(a=>String(a.name||a.type)===String(lab));return a?.percent??null;});
   const pts=vals.map((v,i)=>v==null?null:[x+left+cw*(i/Math.max(1,labels.length-1)),y+top+ch-(Math.max(0,Math.min(100,Number(v)))/100)*ch]).filter(Boolean);
   for(let i=1;i<pts.length;i++)line(doc,pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1],palette[si%palette.length],1.45);
   pts.forEach(pt=>{doc.save().fillColor(palette[si%palette.length]).circle(pt[0],pt[1],2).fill();doc.restore();});
   const ly=y+3+Math.floor(si/3)*8,lx=x+8+(si%3)*(w-16)/3;doc.save().fillColor(palette[si%palette.length]).rect(lx,ly,5,2).fill();doc.restore();text(doc,String(sub.subject_name||'Subject').slice(0,16),lx+7,ly-2,(w-16)/3-10,4.0,false,'#334155','left',{ellipsis:true,height:7,lineBreak:false});
 });
}
function drawSubjectBars(doc,subjects,x,y,w,h,primary,label){
 text(doc,label,x,y-11,w,6.5,true,primary);
 rounded(doc,x,y,w,h,5,'#F8FAFC','#111111');
 const vals=(subjects||[]).filter(s=>s.average!=null||s.annual_average!=null).slice().sort((a,b)=>Number(b.average??b.annual_average)-Number(a.average??a.annual_average)).slice(0,6);
 if(!vals.length){text(doc,'No assessed marks yet',x+5,y+h/2-3,w-10,6,false,'#94a3b8','center');return;}
 const max=Math.max(100,...vals.map(s=>Number(s.average??s.annual_average)||0));
 const rowH=Math.min(10,(h-16)/vals.length);
 vals.forEach((s,i)=>{
   const v=Number(s.average??s.annual_average)||0, yy=y+7+i*rowH;
   text(doc,String(s.subject_name||'Subject').slice(0,18),x+5,yy,w*0.43,4.4,true,'#334155','left',{ellipsis:true,height:rowH,lineBreak:false});
   const bx=x+w*0.45,bw=w*0.42;
   rounded(doc,bx,yy+1,bw,Math.max(4,rowH-3),2,'#E7EDF3',null);
   rounded(doc,bx,yy+1,bw*Math.max(0,Math.min(100,v))/max,Math.max(4,rowH-3),2,primary,null);
   text(doc,fmt(v),bx+bw+3,yy,w-bw-(bx-x)-7,4.4,true,primary,'right');
 });
}
function drawGrading(doc,bands,x,y,w,h,primary){
 text(doc,'GRADING SCALE',x,y,w,5.8,true,primary);
 rounded(doc,x,y+10,w,h-10,4,'#fff','#111111');
 const seen=new Set(),bs=(bands||[]).filter(b=>{const key=String(b.label||'').trim().toUpperCase();if(!key||seen.has(key))return false;seen.add(key);return true;}).slice().sort((a,b)=>Number(b.min_mark)-Number(a.min_mark));
 if(!bs.length){text(doc,'GRADING CONFIGURATION REQUIRED',x+5,y+24,w-10,5.5,true,'#991B1B','center');return;}
 const rows=Math.ceil(bs.length/2),rh=Math.min(9.5,(h-12)/Math.max(1,rows)),half=(w-2)/2;
 bs.forEach((b,i)=>{
   const col=Math.floor(i/rows),row=i%rows,xx=x+1+col*half,yy=y+11+row*rh;
   if(row%2===0)doc.save().fillColor('#F1F4F7').rect(xx,yy,half,rh).fill().restore();
   if(row===0&&col===1)line(doc,xx,yy,xx,yy+rh*rows,'#CBD5E1',.5);
   text(doc,b.label,xx+3,yy+1,24,4.8,true,gradeColor(b.label),'center');
   text(doc,`${b.min_mark}–${b.max_mark}`,xx+29,yy+1,43,4.5,false,'#1F3347','center');
   text(doc,b.descriptor||b.remark||'',xx+74,yy+1,half-78,4.3,false,'#26384A','left',{ellipsis:true,height:rh,lineBreak:false});
 });
}
const JSS_PATHWAYS=[
 {code:'STEM',label:'STEM',icon:'S',description:'Science, technology & mathematics',subjects:/MATHEMAT|SCIENCE|TECHNOLOGY|ENGINEER|COMPUTER|DIGITAL|AGRICULTURE|PRE.?TECH/i},
 {code:'SOCIAL_SCIENCES',label:'SOCIAL SCIENCES',icon:'SS',description:'People, society & citizenship',subjects:/SOCIAL|CITIZEN|HISTORY|GEOGRAPH|RELIG|CRE|IRE|HRE|ENGLISH|KISWAHILI|LANGUAGE|FRENCH|ARABIC/i},
 {code:'ARTS_SPORTS_SCIENCE',label:'ARTS & SPORTS SCIENCE',icon:'AS',description:'Creative, artistic & sporting abilities',subjects:/ART|MUSIC|SPORT|PHYSICAL EDUCATION|\bP\.E\b|DANCE|DRAMA|CREATIVE/i}
];
function parseTemplateConfig(value){if(value&&typeof value==='object')return value;if(typeof value==='string'){try{return JSON.parse(value);}catch{}}return {};}
function resolveGuidanceMode(report){
 const template=String(report.school_template_code||'').toUpperCase(),section=String(report.section_code||'').toUpperCase(),level=String(report.level_code||'').toUpperCase(),type=String(report.report_template_type||'').toUpperCase();
 const config=parseTemplateConfig(report.report_template_config),custom=config.pathway_guidance||config.pathways;
 if(template==='COMPLEX'){
   const entries=Array.isArray(custom)?custom:(Array.isArray(custom?.pathways)?custom.pathways:[]);
  if(entries.length)return {mode:'CUSTOM',pathways:entries.map((p,i)=>({code:String(p.code||`PATHWAY_${i+1}`).toUpperCase(),label:p.name||p.label||p.code||`Pathway ${i+1}`,description:p.description||'',icon:String(p.icon||p.code||'P').slice(0,2),subjects:Array.isArray(p.subjects)&&p.subjects.length?new RegExp(p.subjects.map(v=>String(v).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'i'):null}))};
   if(section==='SENIOR'&&type==='SENIOR_A4'&&/^GRADE_(10|11|12)$/.test(level))return {mode:'SENIOR',config};
   return {mode:'UNAVAILABLE',label:report.section_name||report.level_name||'Configured Complex curriculum'};
 }
 if(template==='JUNIOR'&&type==='JUNIOR_A4'&&/^GRADE_(7|8|9)$/.test(level))return {mode:'JSS',pathways:JSS_PATHWAYS};
 if(template==='SENIOR'&&type==='SENIOR_A4'&&/^GRADE_(10|11|12)$/.test(level))return {mode:'SENIOR',config};
 return {mode:'UNAVAILABLE',label:report.section_name||report.level_name||'Configured curriculum'};
}
function buildPathwayEvidence(report,pathways){
 const source=report.pathway_guidance||{},recorded=source.pathway_evidence&&typeof source.pathway_evidence==='object'?source.pathway_evidence:{};
 const subjects=(report.subjects||[]).filter(s=>(report.report_kind==='ANNUAL'?s.annual_average:s.average)!=null);
 return pathways.map(pathway=>{
   const matcher=pathway.subjects instanceof RegExp?pathway.subjects:null;
   const related=matcher?subjects.filter(s=>matcher.test(`${s.subject_code||''} ${s.subject_name||''}`)):[];
   const observed=recorded[pathway.code]||{};
   const averageOf=subject=>Number(report.report_kind==='ANNUAL'?subject.annual_average:subject.average);
   const average=related.length?related.reduce((sum,s)=>sum+averageOf(s),0)/related.length:null;
   const humanEvidence=related.map(s=>`${s.subject_name}: ${fmt(averageOf(s))}`).slice(0,3).join('; ');
   return {...pathway,related,average,humanEvidence,observed,teacherGuidance:observed.teacher_guidance||''};
 });
}
function resolvePathwayGuidance(report){
 const context=resolveGuidanceMode(report),source=report.pathway_guidance||{};
 if(context.mode==='JSS'){
   const pathways=buildPathwayEvidence(report,context.pathways);
   const ranked=pathways.filter(p=>p.related.length>=2).slice().sort((a,b)=>b.average-a.average);
   const enough=ranked.length>=2;
   return {...context,pathways,strongest:enough?ranked[0]:null,developing:enough?ranked[1]:null,sufficient:enough,source};
 }
 if(context.mode==='CUSTOM')return {...context,pathways:buildPathwayEvidence(report,context.pathways),source};
 return {...context,source,report_subjects:report.subjects||[],report_kind:report.report_kind};
}
function drawPathwayIcon(doc,code,x,y,color){
 doc.save().strokeColor(color).lineWidth(.8).circle(x+5,y+5,5).stroke().fillColor(color).font('Helvetica-Bold').fontSize(4).text(String(code||'P').slice(0,2),x+1,y+3.4,{width:8,align:'center',lineBreak:false});doc.restore();
}
function drawJssGuidance(doc,guidance,x,y,w,h){
 const green='#13804A',innerY=y+10,innerH=h-10,recommendW=230,gap=5,cardGap=3,cardW=(w-recommendW-gap-2*cardGap)/3;
 guidance.pathways.forEach((p,i)=>{
   const xx=x+i*(cardW+cardGap);rounded(doc,xx,innerY,cardW,innerH,3,'#F4FAF6','#B8D7C2');
   drawPathwayIcon(doc,p.icon,xx+4,innerY+4,green);
   text(doc,p.label,xx+16,innerY+4,cardW-19,4.4,true,green,'left',{ellipsis:true,height:6,lineBreak:false});
   const status=p===guidance.strongest?'STRONGEST EMERGING':p===guidance.developing?'DEVELOPING EVIDENCE':p.related.length?'EVIDENCE RECORDED':'INSUFFICIENT EVIDENCE';
  text(doc,p.description,xx+4,innerY+11,cardW-8,3.5,false,'#475569','left',{ellipsis:true,height:5,lineBreak:false});
  text(doc,p.observed.strength||status,xx+4,innerY+18,cardW-8,3.9,true,'#334155','left',{ellipsis:true,height:6,lineBreak:false});
  text(doc,p.observed.evidence||p.humanEvidence||'No relevant assessed results recorded',xx+4,innerY+26,cardW-8,3.7,false,'#475569','left',{height:15,lineBreak:true,ellipsis:true});
  if(p.teacherGuidance)text(doc,p.teacherGuidance,xx+4,innerY+43,cardW-8,3.5,false,'#475569','left',{height:innerH-45,lineBreak:true,ellipsis:true});
 });
 const rx=x+3*cardW+2*cardGap+gap;
 rounded(doc,rx,innerY,recommendW,innerH,3,'#F8FAFC','#B8D7C2');
 text(doc,'EXPLORATORY GUIDANCE',rx+6,innerY+4,recommendW-12,4.5,true,green,'left');
 if(guidance.sufficient){
   const strongest=guidance.strongest,developing=guidance.developing;
   text(doc,`Strongest emerging area: ${strongest.label}`,rx+6,innerY+12,recommendW-12,4.2,true,'#26384A','left',{ellipsis:true,height:6,lineBreak:false});
   text(doc,`Evidence: ${strongest.humanEvidence||strongest.observed.evidence||'Recorded learning-area results'}`,rx+6,innerY+20,recommendW-12,3.9,false,'#475569','left',{height:11,lineBreak:true,ellipsis:true});
   text(doc,`Developing area: ${developing.label}`,rx+6,innerY+33,recommendW-12,4.1,true,'#26384A','left',{ellipsis:true,height:6,lineBreak:false});
   text(doc,strongest.teacherGuidance||guidance.source.teacher_guidance||'Continue exploring through practical activities and learner-teacher discussion.',rx+6,innerY+41,recommendW-12,3.9,false,'#475569','left',{height:innerH-43,lineBreak:true,ellipsis:true});
 }else{
   text(doc,'INSUFFICIENT EVIDENCE FOR PATHWAY GUIDANCE',rx+6,innerY+14,recommendW-12,4.2,true,'#7C4A03','left',{height:12,lineBreak:true,ellipsis:true});
   text(doc,guidance.source.teacher_guidance||'Explore interests and demonstrated abilities with the learner and teachers; this is not a placement decision.',rx+6,innerY+28,recommendW-12,3.9,false,'#475569','left',{height:innerH-31,lineBreak:true,ellipsis:true});
 }
}
function drawSeniorGuidance(doc,guidance,x,y,w,h){
 const source=guidance.source,green='#13804A',innerY=y+10,innerH=h-10,pathway=source.selected_pathway||'';
 rounded(doc,x,innerY,w,innerH,3,'#F8FAFC','#B8D7C2');
 text(doc,`SELECTED PATHWAY: ${pathway||'PATHWAY NOT RECORDED'}`,x+7,innerY+5,w-14,4.8,true,green,'left',{ellipsis:true,height:7,lineBreak:false});
 text(doc,`TRACK / SPECIALISATION: ${source.track_specialisation||'Not recorded'}`,x+7,innerY+14,w-14,4.2,true,'#334155','left',{ellipsis:true,height:6,lineBreak:false});
 const col=(w-20)/2,left=x+7,right=x+13+col,top=innerY+23;
 const selected=String(pathway).toUpperCase(),definition=JSS_PATHWAYS.find(p=>p.code===selected||p.label.toUpperCase()===selected),related=definition?buildPathwayEvidence({subjects:guidance.report_subjects||[],report_kind:guidance.report_kind},[definition])[0].related:[];
 const subjectEvidence=related.slice().sort((a,b)=>Number(b.average)-Number(a.average)).slice(0,3).map(s=>`${s.subject_name} (${fmt(s.average)})`).join(', ');
 const fields=[['STRENGTHS',source.strengths|| (subjectEvidence?`Recorded results: ${subjectEvidence}`:'No relevant subject evidence recorded')],['COMPETENCY DEVELOPMENT',source.competency_development||'No competency record available'],['DEVELOPMENT AREA',source.development_area||'No development area recorded'],['CAREER EXPLORATION',pathway?(source.career_exploration||'No career guidance recorded'):'Requires a recorded pathway']];
 fields.forEach((field,i)=>{const xx=i%2?right:left,yy=top+Math.floor(i/2)*15;text(doc,field[0],xx,yy,col,3.8,true,green);text(doc,field[1],xx,yy+5,col,3.9,false,'#475569','left',{ellipsis:true,height:8,lineBreak:false});});
}
function drawCustomGuidance(doc,guidance,x,y,w,h){
 const green='#13804A',innerY=y+10,innerH=h-10,recommendW=190,gap=5,cardGap=3,pathwayCount=guidance.pathways.length,cardW=(w-recommendW-gap-Math.max(0,pathwayCount-1)*cardGap)/Math.max(1,pathwayCount);
 guidance.pathways.forEach((p,i)=>{const xx=x+i*(cardW+cardGap);rounded(doc,xx,innerY,cardW,innerH,3,'#F4FAF6','#B8D7C2');drawPathwayIcon(doc,p.icon,xx+4,innerY+4,green);text(doc,p.label,xx+16,innerY+4,cardW-19,4.3,true,green,'left',{ellipsis:true,height:6,lineBreak:false});text(doc,p.description,xx+4,innerY+11,cardW-8,3.5,false,'#475569','left',{ellipsis:true,height:5,lineBreak:false});text(doc,p.observed.strength||'STRENGTH NOT RECORDED',xx+4,innerY+18,cardW-8,3.8,true,'#334155','left',{ellipsis:true,height:6,lineBreak:false});text(doc,p.observed.evidence||p.humanEvidence||'No evidence recorded',xx+4,innerY+26,cardW-8,3.7,false,'#475569','left',{height:15,lineBreak:true,ellipsis:true});if(p.teacherGuidance)text(doc,p.teacherGuidance,xx+4,innerY+43,cardW-8,3.5,false,'#475569','left',{height:innerH-45,lineBreak:true,ellipsis:true});});
 const rx=x+pathwayCount*cardW+Math.max(0,pathwayCount-1)*cardGap+gap;
 rounded(doc,rx,innerY,recommendW,innerH,3,'#F8FAFC','#B8D7C2');
 text(doc,guidance.source.selected_pathway?`RECORDED PATHWAY: ${guidance.source.selected_pathway}`:'PATHWAY GUIDANCE',rx+6,innerY+5,recommendW-12,4.3,true,green,'left',{ellipsis:true,height:6,lineBreak:false});
 text(doc,guidance.source.teacher_guidance||'No learner-specific recommendation recorded.',rx+6,innerY+16,recommendW-12,3.9,false,'#475569','left',{height:innerH-19,lineBreak:true,ellipsis:true});
}
function drawPathwayGuidance(doc,report,x,y,w,h,primary){
 const green='#13804A',guidance=resolvePathwayGuidance(report);
 text(doc,'LEARNER STRENGTHS & PATHWAY GUIDANCE',x,y,w,6,true,green);
 if(guidance.mode==='JSS')drawJssGuidance(doc,guidance,x,y,w,h);
 else if(guidance.mode==='CUSTOM')drawCustomGuidance(doc,guidance,x,y,w,h);
 else if(guidance.mode==='SENIOR')drawSeniorGuidance(doc,guidance,x,y,w,h);
 else{
   rounded(doc,x,y+10,w,h-10,3,'#F8FAFC','#B8D7C2');
   text(doc,`PATHWAY STRUCTURE UNAVAILABLE FOR CONFIGURED CURRICULUM: ${guidance.label}`,x+7,y+20,w-14,4.5,true,'#7C4A03','left',{ellipsis:true,height:7,lineBreak:false});
   text(doc,'No pathway recommendation has been inferred.',x+7,y+31,w-14,4.1,false,'#475569');
 }
}
function fitRows(n,available,min,max){return Math.max(min,Math.min(max,Math.floor(available/Math.max(1,n))));}
function drawReportPage(doc,report){
 const primary=hex(report.primary_color,'#12355B'),accent=hex(report.secondary_color,'#B8860B');
 const pageW=595,pageH=842,x=28,w=539,bottom=818;
 // Clean, conventional school report-card layout. Everything is deliberately kept on one A4 page.
 rounded(doc,12,12,pageW-24,pageH-24,6,'#fff','#111111');
 // Formal double school-document frame: simple black outer + inner rules only.
 doc.save().strokeColor('#111111').lineWidth(2.2).rect(10,10,pageW-20,pageH-20).stroke().restore();
 doc.save().strokeColor('#111111').lineWidth(1.1).rect(17,17,pageW-34,pageH-34).stroke().restore();
 // Security-style ZELIMU CBC watermark: subtle, centered, and behind report content.
 if(report.watermark_enabled!==false){if(!drawWatermark(doc,report.logo_url,pageW/2,pageH/2,300,.045))drawTextWatermark(doc,report.school_name,report.motto,pageW/2,pageH/2,420,.035);}
 // Header hierarchy: address/contact above the centered school logo, followed by the school title.
 if(report.logo_url)drawLogo(doc,report.logo_url,pageW/2,34,64);
 text(doc,report.school_name||'SCHOOL',x,102,w,16,true,primary,'center');
 text(doc,report.address||'',x,121,w,6,false,'#334155','center');
 text(doc,report.motto||'',x,132,w,6,false,'#334155','center');
 // School phone belongs directly below the motto, as required for school identity.
 const headerContact=[report.contact_phone].filter(Boolean).join('  |  ');
 if(headerContact)text(doc,headerContact,x,141,w,5.4,false,'#374151','center');
 line(doc,x,151,x+w,151,'#111111',.8);
 text(doc,report.report_kind==='ANNUAL'?'ANNUAL ACADEMIC REPORT':'TERM ACADEMIC REPORT CARD',x,158,w,10.5,true,primary,'center');
 text(doc,`ACADEMIC YEAR ${safe(report.year_label)}${report.report_kind==='TERM'?'  •  '+safe(report.term_name||'TERM'):''}`,x,172,w,5.8,true,'#334155','center');

 // Learner identity block
 const iy=185,ih=58;
 rounded(doc,x,iy,w,ih,5,'#F8FAFC','#111111');
 drawPhoto(doc,report.passport_photo_url,x+7,iy+6,46,46,accent);
 text(doc,'LEARNER',x+62,iy+8,48,5.3,true,primary);
 text(doc,report.learner_name||'—',x+112,iy+7,190,9,true,'#0F172A');
 text(doc,'CLASS / STREAM',x+315,iy+8,70,5.3,true,primary);
 text(doc,`${report.class_name||'—'}${report.stream?' / '+report.stream:''}`,x+388,iy+7,165-28,7,true,'#0F172A');
 text(doc,'ADM. NO.',x+62,iy+30,66,5.3,true,primary);
 text(doc,report.admission_no||'—',x+130,iy+29,82,6,false,'#334155');
 text(doc,'ASSES. NO.',x+220,iy+30,76,5.3,true,primary);
 text(doc,report.assessment_no||'—',x+299,iy+29,78,6,false,'#334155');
 text(doc,'LEVEL',x+388,iy+30,35,5.3,true,primary);
 text(doc,report.level_name||'—',x+428,iy+29,100,6,false,'#334155');
 text(doc,'TERM DATES',x+62,iy+45,60,5.3,true,primary);
 text(doc,`${fmtDate(report.opening_date)} – ${fmtDate(report.closing_date)}`,x+125,iy+44,220,5.3,false,'#334155');
 text(doc,'SCHOOL CALENDAR',x+348,iy+45,70,5.3,true,primary);
 text(doc,(report.reopening_date||report.next_term_opening_date)?`Reopens: ${fmtDate(report.reopening_date||report.next_term_opening_date)}`:'Reopening date: —',x+420,iy+44,125,5.1,false,'#334155');

 let y=240;
 if(report.report_kind==='ANNUAL'){
   text(doc,'ANNUAL SUBJECT PERFORMANCE',x,y,w,6.5,true,primary);y+=9;
   const c=[x,x+175,x+230,x+285,x+340,x+385,x+438,x+w];
   const heads=['SUBJECT / LEARNING AREA','TERM 1','TERM 2','TERM 3','ANNUAL','GRADE','RANK'];
   rounded(doc,x,y,w,18,2,primary);
   heads.forEach((h,i)=>text(doc,h,c[i]+2,y+5,c[i+1]-c[i]-4,4.4,true,'#fff','center'));
   y+=18;
   const rows=report.subjects||[],rh=fitRows(rows.length,176,10,15);
   rows.forEach((s,i)=>{
     if(i%2===0)doc.save().fillColor('#F8FAFC').rect(x,y,w,rh).fill().restore();
     doc.strokeColor('#111111').lineWidth(.9).rect(x,y,w,rh).stroke();
     text(doc,s.subject_name||'Subject',x+4,y+3,167,4.8,true,'#1E293B','left',{ellipsis:true,height:rh,lineBreak:false});
     [1,2,3].forEach((tn,j)=>text(doc,s.terms?.[tn]==null?'':fmt(s.terms[tn]),c[j+1]+2,y+3,51,4.7,false,'#334155','center'));
     text(doc,s.annual_average==null?'':fmt(s.annual_average),c[4]+2,y+3,41,4.8,true,'#0F172A','center');
     text(doc,s.grade||'',c[5]+2,y+2,43,4.8,true,gradeColor(s.grade),'center');
     text(doc,s.subject_rank==null?'':String(s.subject_rank),c[6]+2,y+3,51,4.7,true,primary,'center');
     y+=rh;
   });
 } else {
   const subjectRows=report.subjects||[];
   const tableCapacity=Math.max(110,482-(y+25));
   const subjectLayoutWarning=subjectRows.length>Math.floor(tableCapacity/8);
   // Give the report-table title its own clear band. The previous underline sat
   // too close to the title and could visually cut through the heading when PDF
   // text metrics differed between viewers.
   rounded(doc,x,y-2,w,21,3,'#F8FAFC','#111111');
   text(doc,'SUBJECT PERFORMANCE AND TEACHER FEEDBACK',x+8,y+4,subjectLayoutWarning?310:w-16,7.2,true,primary,'left',{height:11,lineBreak:false,ellipsis:true});
   if(subjectLayoutWarning)text(doc,'ONE-PAGE READABILITY LIMIT: ALL SUBJECTS RETAINED',x+315,y+7,w-323,4.2,true,'#991B1B','right',{height:7,lineBreak:false,ellipsis:true});
   y+=25;
   // One column per exam captured this term, including CATs. The remaining
   // columns keep the report-card layout intact and every column is scaled to
   // the printable A4 width.
   const examColumns=report.exam_columns||[];
   const columns=[
     {key:'subject',label:'SUBJECT',weight:1.9,align:'left'},
     ...examColumns.map(column=>({
       key:`exam:${column.key}`,
       label:String(column.name||column.type||'EXAM').toUpperCase(),
       weight:0.75,
       align:'center',
       exam:column
     })),
     {key:'average',label:'AVERAGE',weight:0.75,align:'center'},
     {key:'grade',label:'GRADE',weight:0.6,align:'center'},
     {key:'teacher',label:'TEACHER',weight:1.0,align:'center'},
     {key:'comment',label:'COMMENT',weight:2.1,align:'left'}
   ];
   const weightSum=columns.reduce((n,col)=>n+col.weight,0);
   columns.forEach(col=>{col.width=(w*col.weight)/weightSum;});
   // Reconcile the final column to the exact printable width so no rounding can
   // create a hidden/overlapping column at the right edge of the A4 page.
   const widthSum=columns.reduce((n,col)=>n+col.width,0);
   columns[columns.length-1].width += (w-widthSum);
   const c=[x];
   columns.forEach(col=>c.push(c[c.length-1]+col.width));

   const examEntry=(subject,column)=>{
     const list=subject.assessments||[];
     return list.find(a=>String(a.column_key||'')===String(column.key))
       || list.find(a=>column.id!=null&&String(a.id)===String(column.id))
       || list.find(a=>String(a.name||'').toUpperCase()===String(column.name||'').toUpperCase());
   };
   const examValue=(subject,column)=>{
     const entry=examEntry(subject,column);
     if(!entry||entry.mark==null)return '';
     const max=Number(entry.max_mark)||100;
     return Math.abs(max-100)<0.001?fmt(entry.mark):`${fmt(entry.mark)}/${fmt(max)}`;
   };

  rounded(doc,x,y,w,25,2,primary);
   columns.forEach((col,i)=>{
     const xx=c[i],cw=col.width;
     const headerSize=col.exam?Math.max(3.5,Math.min(4.2,cw/9)):(col.key==='comment'||col.key==='teacher'?4.7:4.4);
     text(doc,col.label,xx+2,y+(col.key==='subject'?5:3),cw-4,headerSize,true,'#fff',col.align==='left'?'left':'center',{height:20,lineBreak:col.key!=='subject'&&col.key!=='comment'&&col.key!=='teacher',ellipsis:true});
     if(i<columns.length-1)line(doc,c[i+1],y,c[i+1],y+25,'#FFFFFF',1);
   });
   y+=25;
   const rows=report.subjects||[];
   // Keep the complete table inside the A4 body while preserving a usable teacher
   // and automatic-comment column. The minimum row height prevents text collision.
   // A4-safe: allocate only the physical space available before the summary.
   // Many subjects must shrink their row height instead of flowing beyond the page.
  const availableTableHeight=Math.max(110, 482-y);
   const rh=rows.length?Math.max(5.2,Math.min(22,availableTableHeight/rows.length)):22;
   rows.forEach((s,i)=>{
     if(i%2===0)doc.save().fillColor('#FBFCFD').rect(x,y,w,rh).fill().restore();
     // Draw each cell independently. This is the visual guarantee that all eight
     // possible columns (seven in Term 3) remain present and separated.
     columns.forEach((col,ci)=>{
       doc.save().strokeColor('#111111').lineWidth(.9).rect(c[ci],y,col.width,rh).stroke().restore();
     });

     const teacher=(s.teacher_name||'').trim();
     const initials=(s.teacher_initials||'').trim();
     const teacherLabel=teacher && initials ? `${teacher}\n(${initials})` : (teacher || initials || '');

     const values={
       subject:s.subject_name||'Subject',
       average:s.average==null?'NOT ASSESSED':fmt(s.average),
       grade:s.grade||'—',
       teacher:teacherLabel,
       comment:s.comment||''
     };
     for(const column of examColumns)values[`exam:${column.key}`]=examValue(s,column);

     columns.forEach((col,ci)=>{
       const xx=c[ci],cw=col.width;
       let value=values[col.key]??'';
       if(col.key==='teacher'){
         // Teacher is deliberately confined to the teacher cell. Two short lines
         // (name + initials) are used rather than allowing the text to flow across
         // the neighbouring GRADE/COMMENT cells.
         text(doc,value,xx+3,y+Math.max(2,(rh-7)/2),cw-6,Math.max(3.5,Math.min(4.6,rh-3)),true,'#334155','center',{height:Math.max(3,rh-2),lineBreak:true,ellipsis:true});
       }else if(col.key==='comment'){
         text(doc,value,xx+5,y+Math.max(2,(rh-8)/2),cw-10,Math.max(3.5,Math.min(4.8,rh-3)),false,'#334155','left',{height:Math.max(3,rh-2),lineBreak:true,ellipsis:true});
       }else if(col.key==='subject'){
         text(doc,value,xx+4,y+Math.max(2,(rh-9)/2),cw-8,Math.max(4,Math.min(5.8,rh-2)),true,'#111827','left',{height:Math.max(3,rh-2),lineBreak:false,ellipsis:true});
       }else if(col.exam){
         text(doc,value,xx+1,y+Math.max(2,(rh-9)/2),cw-2,Math.max(3.6,Math.min(4.8,rh-2)),true,'#1F2937','center',{height:Math.max(3,rh-2),lineBreak:false,ellipsis:true});
       }else{
         text(doc,value,xx+2,y+Math.max(2,(rh-9)/2),cw-4,Math.max(4,col.key==='grade'?Math.min(6,rh-2):Math.min(5.5,rh-2)),true,col.key==='grade'?gradeColor(s.grade):'#1F2937','center',{height:Math.max(3,rh-2),lineBreak:false,ellipsis:true});
       }
     });
     y+=rh;
   });
 }
 // Overall summary
 y+=7;
 const assessedCount=(report.subjects||[]).filter(s=>report.report_kind==='ANNUAL'?s.annual_average!=null:s.average!=null).length;
 const subjectCount=(report.subjects||[]).length;
 const gradeBand=(report.grading_bands||[]).find(b=>String(b.label||'').toUpperCase()===String(report.overall_grade||'').toUpperCase());
 const performanceStatus=assessedCount===0
   ? ((report.exam_columns||[]).length?'NOT EVALUATED':'ASSESSMENT PENDING')
   : assessedCount<subjectCount?`PARTIAL RESULTS ${assessedCount}/${subjectCount}`:(gradeBand?.descriptor||gradeBand?.remark||'ASSESSED');
 const cardW=(w-18)/4, cards=[
   ['TOTAL MARKS',report.overall_total_marks==null?'—':`${fmt(report.overall_total_marks)} / ${fmt(report.overall_total_marks_possible||0)}`],
   ['OVERALL AVERAGE',report.overall_average==null?'—':fmt(report.overall_average)],
   ['OVERALL GRADE',report.overall_grade||'—'],
   ['PERFORMANCE STATUS',performanceStatus]
 ];
 cards.forEach((a,i)=>{const xx=x+i*(cardW+6);rounded(doc,xx,y,cardW,34,3,'#F8FAFC','#111111');text(doc,a[0],xx+4,y+5,cardW-8,4.0,true,primary,'center',{ellipsis:true,height:6,lineBreak:false});text(doc,a[1],xx+4,y+17,cardW-8,i===3?5.2:7,true,i===3&&assessedCount===0?'#7C4A03':'#0F172A','center',{ellipsis:true,height:10,lineBreak:false});});
 y+=42;

 const gs=report.grading_system,hasGradingConfig=Boolean(gs||(report.grading_bands||[]).length);
 text(doc,gs?`GRADING USED: ${String(gs.name||'Configured grading system').toUpperCase()}${gs.code?` (${gs.code})`:''}`:hasGradingConfig?'CONFIGURED GRADING SCALE':'GRADING CONFIGURATION REQUIRED',x,y,w,5.8,true,hasGradingConfig?primary:'#991B1B','left');
 y+=9;
 drawGrading(doc,report.grading_bands||[],x,y,w,54,primary);
 y+=61;

 drawPathwayGuidance(doc,report,x,y,w,67,primary);
 y+=73;

 // Keep recorded remarks; generated default remarks are supplied by the report engine.
 const rw=(w-8)/2, rh=43;
 rounded(doc,x,y,rw,rh,4,'#fff','#111111');rounded(doc,x+rw+8,y,rw,rh,4,'#fff','#111111');
 text(doc,"CLASS TEACHER'S REMARK",x+7,y+5,rw-14,4.7,true,primary);
 text(doc,report.recorded_teacher_comment||report.class_teacher_remark||'—',x+7,y+14,rw-14,5,false,'#334155','left',{height:25,lineBreak:true});
 text(doc,"HEAD TEACHER'S REMARK",x+rw+15,y+5,rw-14,4.7,true,primary);
 text(doc,report.recorded_headteacher_comment||report.head_teacher_remark||'—',x+rw+15,y+14,rw-14,5,false,'#334155','left',{height:25,lineBreak:true});
 y+=51;

 // Signature / stamp strip
 const sy=Math.min(y+5,748);
 const sigW=150;
 line(doc,x,sy,x+sigW,sy,'#111111',.9);line(doc,x+195,sy,x+195+sigW,sy,'#111111',.9);line(doc,x+390,sy,x+w,sy,'#111111',.9);
 const cs=assetPath(report.class_teacher_signature_url),hs=assetPath(report.head_teacher_signature_url),st=assetPath(report.stamp_url);
 if(cs)try{doc.image(cs,x+18,sy-29,{fit:[110,27]});}catch{}
 if(hs)try{doc.image(hs,x+213,sy-29,{fit:[110,27]});}catch{}
 if(st)try{
   // Keep the stamp entirely inside the reserved stamp panel. A white backing
   // prevents transparent/irregular stamps from visually bleeding into the
   // signature labels while still leaving a little breathing room.
   doc.save().fillColor('#FFFFFF').rect(x+395,sy-39,143,37).fill().restore();
   doc.image(st,x+424,sy-35,{fit:[58,30],align:'center',valign:'center'});
 }catch{}
 text(doc,report.class_teacher||'CLASS TEACHER',x,sy+4,sigW,4.8,true,primary,'center');
 text(doc,report.head_teacher||'HEAD TEACHER',x+195,sy+4,sigW,4.8,true,primary,'center');
 text(doc,'SCHOOL STAMP',x+390,sy+4,149,4.8,true,primary,'center');
 text(doc,`Class Teacher  •  ${report.class_teacher_staff_no||'Staff No. —'}`,x,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Head Teacher  •  ${report.head_teacher_staff_no||'Staff No. —'}`,x+195,sy+15,190,4.2,false,'#64748B','center');
 text(doc,`Opening ${fmtDate(report.opening_date)} · Closing ${fmtDate(report.closing_date)}`,x+390,sy+15,149,4.2,false,'#64748B','center');
 line(doc,x,792,x+w,792,accent,.9);
 text(doc,`ZELIMU CBC • ${report.contact_email||'School contact email'} • Academic report • Generated from recorded school assessment data`,x,799,w,4.2,false,'#475569','center');
}
function renderFallbackBuffer(report,error){
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
    const chunks=[];
    doc.on('data',c=>chunks.push(c));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
    const primary=hex(report?.primary_color,'#12355B');
    rounded(doc,28,28,539,786,8,'#fff','#111111');
    text(doc,'ZELIMU CBC REPORT CARD',55,70,485,18,true,primary,'center');
    text(doc,report?.school_name||'SCHOOL',55,105,485,12,true,'#0F172A','center');
    line(doc,55,130,540,130,'#111111',1);
    text(doc,report?.report_kind==='ANNUAL'?'ANNUAL ACADEMIC REPORT':'TERM ACADEMIC REPORT CARD',55,155,485,10,true,primary,'center');
    text(doc,`Learner: ${report?.learner_name||'—'}`,55,195,485,9,true,'#111827');
    text(doc,`Academic year: ${report?.year_label||'—'}`,55,215,485,8,false,'#334155');
    text(doc,`Class: ${report?.class_name||'—'}${report?.stream?' / '+report.stream:''}`,55,235,485,8,false,'#334155');
    text(doc,'The detailed report layout could not be rendered from the recorded data.',55,285,485,9,true,'#991B1B','center');
    text(doc,'The report data was generated successfully. Please reopen the report after checking the school/report configuration.',75,310,445,8,false,'#334155','center',{height:35,lineBreak:true});
    text(doc,`Render detail: ${String(error?.message||'unknown error').slice(0,220)}`,55,380,485,6,false,'#64748B','left',{height:60,lineBreak:true});
    text(doc,'ZELIMU CBC • Generated from recorded school assessment data',55,780,485,6,false,'#475569','center');
    doc.end();
  });
}
function renderBuffer(report){
  const safeReport=normalizeReport(report);
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
    const chunks=[];
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};
    doc.on('data',c=>chunks.push(c));
    doc.on('end',()=>finish(resolve,Buffer.concat(chunks)));
    doc.on('error',async err=>{
      try{const fallback=await renderFallbackBuffer(safeReport,err);finish(resolve,fallback);}
      catch(e){finish(reject,e);}
    });
    try{
      drawReportPage(doc,safeReport);
      doc.end();
    }catch(err){
      try{doc.end();}catch{}
      renderFallbackBuffer(safeReport,err).then(v=>finish(resolve,v)).catch(reject);
    }
  });
}

async function reportPdf(report,res){
  const normalized=normalizeReport(report);
  const cacheKey=`${normalized.report_kind}|${normalized.school_code||normalized.school_name||''}|${normalized.learner_id||normalized.learner_name||''}|${normalized.year_label||''}|${normalized.term_id||normalized.term_name||''}`;
  let bytes=reportPdfCacheGet(cacheKey);
  if(!bytes){bytes=await renderBuffer(normalized);reportPdfCachePut(cacheKey,bytes);}
  if(!bytes || !bytes.length)throw new Error('PDF renderer returned an empty document.');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Disposition',`inline; filename="${safe(normalized.learner_name||'report').replace(/[^a-z0-9_-]/gi,'_')}.pdf"`);
  res.end(bytes);
}

function drawFallbackPageOnDocument(doc,report,error){
 const primary=hex(report?.primary_color,'#12355B');
 rounded(doc,28,28,539,786,8,'#fff','#111111');
 text(doc,'ZELIMU CBC REPORT CARD',55,70,485,18,true,primary,'center');
 text(doc,report?.school_name||'SCHOOL',55,105,485,12,true,'#0F172A','center');
 line(doc,55,130,540,130,'#111111',1);
 text(doc,report?.report_kind==='ANNUAL'?'ANNUAL ACADEMIC REPORT':'TERM ACADEMIC REPORT CARD',55,155,485,10,true,primary,'center');
 text(doc,`Learner: ${report?.learner_name||'—'}`,55,195,485,9,true,'#111827');
 text(doc,`Academic year: ${report?.year_label||'—'}`,55,215,485,8,false,'#334155');
 text(doc,`Term: ${report?.term_name||'—'}`,55,235,485,8,false,'#334155');
 text(doc,`Class: ${report?.class_name||'—'}${report?.stream?' / '+report.stream:''}`,55,255,485,8,false,'#334155');
 text(doc,'The detailed report layout could not be rendered for this learner.',55,305,485,9,true,'#991B1B','center');
 text(doc,`Render detail: ${String(error?.message||'unknown error').slice(0,220)}`,55,345,485,6,false,'#64748B','left',{height:60,lineBreak:true});
 text(doc,'ZELIMU CBC • Generated from recorded school assessment data',55,780,485,6,false,'#475569','center');
}
async function buildReportPdfsBuffer(reports){
 const list=Array.isArray(reports)?reports.filter(Boolean).map(normalizeReport):[];
 if(!list.length) throw new Error('No report cards available for the selected class.');
 // Render the entire class into ONE PDFKit document. The previous implementation
 // rendered every learner to a separate PDF buffer and then loaded/copied all those
 // buffers through pdf-lib. That duplicated the PDF data in memory and was the main
 // failure point for larger classes on Render.
 return new Promise((resolve,reject)=>{
   const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
   const chunks=[]; let pages=0, settled=false;
   const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};
   doc.on('data',c=>chunks.push(c));
   doc.on('end',()=>{
     if(pages<list.length){finish(reject,new Error(`Whole-class report build incomplete: ${list.length} learner reports requested, ${pages} pages produced.`));return;}
     finish(resolve,{bytes:Buffer.concat(chunks),count:list.length,pages});
   });
   doc.on('error',e=>finish(reject,e));
   try{
     list.forEach((report,index)=>{
       if(index>0)doc.addPage({size:'A4',margin:0});
       try{drawReportPage(doc,report);}
       catch(e){
         // Keep the class PDF usable even when one learner has malformed optional
         // report data: render the compact fallback on the current page.
         drawFallbackPageOnDocument(doc,report,e);
       }
       pages++;
     });
     doc.end();
   }catch(e){try{doc.end();}catch{}finish(reject,e);}
 });
}
async function reportPdfs(reports,res,download=false){
 const built=await buildReportPdfsBuffer(reports);
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Pro-Mark-Report-Count',String(built.count));
 res.setHeader('X-Pro-Mark-Page-Count',String(built.pages));
 res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="class-report-cards.pdf"`);
 res.end(built.bytes);
}

async function streamReportPdfs(reportFactory,res,opts={}){
 const expected=Number(opts.expectedCount||0),download=opts.download===true;
 res.setHeader('Content-Type','application/pdf');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Pro-Mark-Expected-Report-Count',String(expected));
 res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="class-report-cards.pdf"`);
 const doc=new PDFDocument({size:'A4',margin:0,autoFirstPage:true});
 let pages=0;
 doc.on('error',e=>{try{res.destroy(e);}catch{}});
 doc.pipe(res);
 try{
   for await (const item of reportFactory()){
     const report=normalizeReport(item);
     if(pages>0)doc.addPage({size:'A4',margin:0});
     try{drawReportPage(doc,report);}catch(e){drawFallbackPageOnDocument(doc,report,e);}
     pages++;
   }
   if(!pages)throw new Error('No report cards available for the selected class.');
   doc.end();
 }catch(e){
   try{drawFallbackPageOnDocument(doc,{school_name:'ZELIMU CBC',report_kind:'TERM'},e);doc.end();}catch{try{doc.end();}catch{}}
   throw e;
 }
}
module.exports={reportPdf,reportPdfs,buildReportPdfsBuffer,streamReportPdfs,drawReportPage,resolvePathwayGuidance,invalidateReportPdfCache};
