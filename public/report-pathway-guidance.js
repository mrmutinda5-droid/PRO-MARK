(()=>{
 const $=id=>document.getElementById(id),token=()=>localStorage.getItem('token')||'';
 let user={};try{user=JSON.parse(localStorage.getItem('user')||'{}');}catch{}
 const schoolId=user.school_id||new URLSearchParams(location.search).get('school_id');
 const reportSection=$('reports'),anchor=reportSection?.querySelector('.report-designation-panel');
 if(!anchor||!schoolId)return;
 const card=document.createElement('div');card.className='card-subsection';card.innerHTML=`
  <div class="section-title"><h3>Learner strengths &amp; pathway guidance</h3><span class="pill">Term-scoped learner guidance</span></div>
  <form id="pathwayGuidanceForm">
   <div class="grid">
    <label>Selected pathway<input name="selected_pathway" maxlength="120"></label>
    <label>Track / specialisation<input name="track_specialisation" maxlength="120"></label>
    <label>Strengths<textarea name="strengths" rows="2" maxlength="1000"></textarea></label>
    <label>Competency development<textarea name="competency_development" rows="2" maxlength="1000"></textarea></label>
    <label>Development area<textarea name="development_area" rows="2" maxlength="1000"></textarea></label>
    <label>Career exploration<textarea name="career_exploration" rows="2" maxlength="1000"></textarea></label>
    <label>Teacher guidance<textarea name="teacher_guidance" rows="2" maxlength="1000"></textarea></label>
   </div>
   <div id="pathwayEvidenceFields" class="grid"></div>
   <div class="actions"><button class="btn secondary" id="loadPathwayGuidance" type="button">Load guidance</button><button class="btn primary" type="submit">Save guidance</button><span id="pathwayGuidanceStatus" class="muted small" role="status"></span></div>
  </form>`;
 anchor.insertAdjacentElement('afterend',card);
 const form=$('pathwayGuidanceForm'),status=$('pathwayGuidanceStatus');
 const request=async(url,options={})=>{
  const headers={'Authorization':'Bearer '+token(),...(options.body?{'Content-Type':'application/json'}:{})};
  const response=await fetch(url,{...options,headers});let data={};
  try{data=await response.json();}catch{}
  if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);
  return data;
 };
 const context=()=>({learner_id:$('reportLearner')?.value,academic_year_id:$('reportYear')?.value,term_id:$('reportTerm')?.value});
 const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 function pathwaysFor(report){
  const template=String(report.school_template_code||'').toUpperCase(),level=String(report.level_code||'').toUpperCase();
  if(template==='JUNIOR'&&/^GRADE_(7|8|9)$/.test(level))return [
   {code:'STEM',label:'STEM'},
   {code:'SOCIAL_SCIENCES',label:'Social Sciences'},
   {code:'ARTS_SPORTS_SCIENCE',label:'Arts & Sports Science'}
  ];
  if(template==='COMPLEX'){
   const config=report.report_template_config||{},source=config.pathway_guidance||config.pathways||{};
   const list=Array.isArray(source)?source:source.pathways;
   if(Array.isArray(list))return list.map((item,index)=>({code:String(item.code||`PATHWAY_${index+1}`).toUpperCase(),label:item.name||item.label||item.code||`Pathway ${index+1}`}));
  }
  return [];
 }
 function renderEvidenceFields(paths,values={}){
  const box=$('pathwayEvidenceFields');
  box.innerHTML=paths.map(path=>{
   const key=escapeHtml(path.code),label=escapeHtml(path.label);
   return `<fieldset class="item"><legend>${label}</legend><label>${label} strength<input data-path-code="${key}" data-path-field="strength" maxlength="500"></label><label>${label} evidence<textarea data-path-code="${key}" data-path-field="evidence" rows="2" maxlength="500"></textarea></label><label>${label} teacher guidance<textarea data-path-code="${key}" data-path-field="teacher_guidance" rows="2" maxlength="500"></textarea></label></fieldset>`;
  }).join('');
  for(const field of box.querySelectorAll('[data-path-code]'))field.value=values[field.dataset.pathCode]?.[field.dataset.pathField]||'';
 }
 async function load(){
  const ctx=context();if(!ctx.learner_id||!ctx.academic_year_id||!ctx.term_id){status.textContent='Select a learner, academic year and term.';return;}
  status.textContent='Loading…';
  try{
   const report=await request(`/api/reports/${schoolId}/term/${ctx.learner_id}/${ctx.academic_year_id}/${ctx.term_id}`);
   const record=await request(`/api/reports/${schoolId}/pathway-guidance/${ctx.learner_id}/${ctx.academic_year_id}/${ctx.term_id}`);
   for(const field of ['selected_pathway','track_specialisation','strengths','competency_development','development_area','career_exploration','teacher_guidance'])form.elements.namedItem(field).value=record[field]||'';
   renderEvidenceFields(pathwaysFor(report),record.pathway_evidence||{});
   status.textContent=Object.keys(record).length?'Saved guidance loaded.':'No pathway guidance recorded for this term.';
  }catch(error){status.textContent=error.message;}
 }
 $('loadPathwayGuidance').addEventListener('click',load);
 form.addEventListener('submit',async event=>{
  event.preventDefault();const ctx=context();if(!ctx.learner_id||!ctx.academic_year_id||!ctx.term_id){status.textContent='Select a learner, academic year and term.';return;}
  const body={...ctx};
  for(const field of ['selected_pathway','track_specialisation','strengths','competency_development','development_area','career_exploration','teacher_guidance'])body[field]=form.elements.namedItem(field).value;
  body.pathway_evidence={};
  for(const field of document.querySelectorAll('#pathwayEvidenceFields [data-path-code]')){
   const entry=body.pathway_evidence[field.dataset.pathCode]||(body.pathway_evidence[field.dataset.pathCode]={});
   entry[field.dataset.pathField]=field.value;
  }
  status.textContent='Saving…';
  try{
   await request(`/api/reports/${schoolId}/pathway-guidance`,{method:'PUT',body:JSON.stringify(body)});
   window.clearProtectedPdfCache?.();status.textContent='Pathway guidance saved. Reopen the report to see the update.';
  }catch(error){status.textContent=error.message;}
 });
 for(const id of ['reportLearner','reportYear','reportTerm'])$(id)?.addEventListener('change',()=>load());
})();