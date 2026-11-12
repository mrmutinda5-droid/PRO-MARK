const test=require('node:test');
const assert=require('node:assert/strict');
const {PDFDocument}=require('pdf-lib');
const {buildReportPdfsBuffer,resolvePathwayGuidance}=require('../backend/services/report-pdf');

const jssBase={school_template_code:'JUNIOR',report_template_type:'JUNIOR_A4',section_code:'JUNIOR'};
const evidenceSubjects=[
 {subject_name:'Mathematics',average:90},
 {subject_name:'Integrated Science',average:80},
 {subject_name:'Social Studies',average:70},
 {subject_name:'English',average:70},
 {subject_name:'Art and Craft',average:65}
];

for(const grade of ['GRADE_7','GRADE_8','GRADE_9']){
 test(`JSS ${grade} uses three exploratory pathways`,()=>{
  const guidance=resolvePathwayGuidance({...jssBase,level_code:grade,subjects:evidenceSubjects});
  assert.equal(guidance.mode,'JSS');
  assert.deepEqual(guidance.pathways.map(p=>p.code),['STEM','SOCIAL_SCIENCES','ARTS_SPORTS_SCIENCE']);
  assert.equal(guidance.strongest.code,'STEM');
  assert.equal(guidance.developing.code,'SOCIAL_SCIENCES');
 });
}

test('JSS does not name a strongest pathway when fewer than two areas have sufficient evidence',()=>{
 const guidance=resolvePathwayGuidance({...jssBase,level_code:'GRADE_8',subjects:[{subject_name:'Mathematics',average:80},{subject_name:'Integrated Science',average:75}]});
 assert.equal(guidance.sufficient,false);
 assert.equal(guidance.strongest,null);
});

for(const grade of ['GRADE_10','GRADE_11','GRADE_12']){
 test(`Senior ${grade} uses only the recorded pathway and development details`,()=>{
  const guidance=resolvePathwayGuidance({school_template_code:'SENIOR',report_template_type:'SENIOR_A4',section_code:'SENIOR',level_code:grade,pathway_guidance:{selected_pathway:'STEM',track_specialisation:'Engineering',development_area:'Practical investigations'}});
  assert.equal(guidance.mode,'SENIOR');
  assert.equal(guidance.source.selected_pathway,'STEM');
  assert.equal(guidance.source.track_specialisation,'Engineering');
 });
}

test('Complex uses its configured pathway structure when supplied',()=>{
 const guidance=resolvePathwayGuidance({school_template_code:'COMPLEX',report_template_type:'TRANSITIONAL_A4',section_code:'TRANSITIONAL_SECONDARY',level_code:'FORM_3',report_template_config:{pathway_guidance:{pathways:[{code:'TECHNICAL',name:'Technical Studies',subjects:['Construction']}]}}});
 assert.equal(guidance.mode,'CUSTOM');
 assert.equal(guidance.pathways[0].code,'TECHNICAL');
});

test('Complex with no configured pathway structure remains unavailable',()=>{
 const guidance=resolvePathwayGuidance({school_template_code:'COMPLEX',report_template_type:'TRANSITIONAL_A4',section_code:'TRANSITIONAL_SECONDARY',level_code:'FORM_3'});
 assert.equal(guidance.mode,'UNAVAILABLE');
});

test('Complex Senior section follows its configured Senior template and grade',()=>{
 const guidance=resolvePathwayGuidance({school_template_code:'COMPLEX',report_template_type:'SENIOR_A4',section_code:'SENIOR',level_code:'GRADE_12',pathway_guidance:{selected_pathway:'Social Sciences'}});
 assert.equal(guidance.mode,'SENIOR');
 assert.equal(guidance.source.selected_pathway,'Social Sciences');
});

test('reports with no assessment evidence do not identify a JSS strength',()=>{
 const guidance=resolvePathwayGuidance({...jssBase,level_code:'GRADE_9',subjects:[{subject_name:'Mathematics',average:null},{subject_name:'Integrated Science',average:null}]});
 assert.equal(guidance.sufficient,false);
 assert.equal(guidance.strongest,null);
});

test('JSS, Senior and Complex reports retain one A4 page with many subjects',async()=>{
 const subjects=Array.from({length:18},(_,index)=>({subject_name:`Learning Area ${index+1}`,average:70,grade:'EE2'}));
 const common={report_kind:'TERM',school_name:'Test School',learner_name:'Test Learner',grading_bands:[],subjects};
 const reports=[
  {...common,school_template_code:'JUNIOR',report_template_type:'JUNIOR_A4',section_code:'JUNIOR',level_code:'GRADE_9'},
  {...common,school_template_code:'SENIOR',report_template_type:'SENIOR_A4',section_code:'SENIOR',level_code:'GRADE_10',pathway_guidance:{selected_pathway:'STEM'}},
  {...common,school_template_code:'COMPLEX',report_template_type:'TRANSITIONAL_A4',section_code:'TRANSITIONAL_SECONDARY',level_code:'FORM_3',report_template_config:{pathway_guidance:{pathways:[{code:'TECHNICAL',name:'Technical',subjects:['Learning Area']}]}}}
 ];
 const result=await buildReportPdfsBuffer(reports),pdf=await PDFDocument.load(result.bytes);
 assert.equal(result.pages,3);
 assert.equal(pdf.getPageCount(),3);
 for(const page of pdf.getPages()){
  assert.ok(Math.abs(page.getWidth()-595.28)<1);
  assert.ok(Math.abs(page.getHeight()-841.89)<1);
 }
});