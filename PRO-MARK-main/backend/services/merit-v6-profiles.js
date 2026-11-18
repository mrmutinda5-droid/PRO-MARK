'use strict';
const {validateWeights}=require('./merit-v6-engine');
function parseProfileInput(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('JSON object required.'),{status:400});
 const {academic_year_id,term_id,class_id}=body;
 if(!academic_year_id||!term_id)throw Object.assign(new Error('Academic year and term are required.'),{status:400});
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 for(const [key,value] of Object.entries({academic_year_id,term_id,...(class_id?{class_id}:{})}))if(!uuid.test(String(value)))throw Object.assign(new Error('Invalid '+key),{status:400});
 let weights;
 try{weights=validateWeights(body.weights);}catch(e){throw Object.assign(e,{status:400});}
 return {academic_year_id,term_id,class_id:class_id||null,weights};
}
module.exports={parseProfileInput};
