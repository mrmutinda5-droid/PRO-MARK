'use strict';

const ID_CARD_TEMPLATES=[
 {id:'classic',name:'Classic School ID',description:'Navy and gold with a formal school header.'},
 {id:'modern',name:'Modern Color-Block',description:'Clean blue-and-white ID with a large portrait.'},
 {id:'academic',name:'Academic Crest',description:'Formal navy panels and a gold identification ribbon.'}
];
const CERTIFICATE_TEMPLATES=[
 {id:'classic',name:'Classic Formal',description:'Navy and gold decorative frame.'},
 {id:'modern',name:'Modern Clean',description:'Contemporary white and blue layout.'},
 {id:'academic',name:'Academic Honour',description:'Ceremonial crest and academic award styling.'},
 {id:'subject-champion',name:'Subject Champion',description:'Royal-blue subject award with a gold medal.'},
 {id:'most-improved',name:'Most Improved Learner',description:'Navy and gold recognition with an achievement star.'},
 {id:'sports-achievement',name:'Sports Achievement',description:'Green-and-gold sporting award with trophy accents.'},
 {id:'participation',name:'Certificate of Participation',description:'Navy, purple and gold co-curricular design.'}
];
const CERTIFICATE_CATEGORIES=new Set([
 'ACADEMIC_ACHIEVEMENT','SUBJECT_PERFORMANCE','MOST_IMPROVED','COMPLETION',
 'CO_CURRICULAR','SPORTS','SCHOOL_RECOGNITION'
]);

function documentTemplates(type){
 if(type==='ID_CARD')return ID_CARD_TEMPLATES;
 if(type==='CERTIFICATE')return CERTIFICATE_TEMPLATES;
 return [];
}

function documentTemplate(value,type='ID_CARD'){
 const template=String(value||'classic');
 return documentTemplates(type).some(option=>option.id===template)?template:null;
}

function validDocumentCategory(value){
 return CERTIFICATE_CATEGORIES.has(String(value||''));
}

module.exports={documentTemplate,documentTemplates,validDocumentCategory};
