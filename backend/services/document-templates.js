'use strict';

const TEMPLATE_IDS=new Set(['classic','modern','academic']);

function documentTemplate(value){
 const template=String(value||'classic');
 return TEMPLATE_IDS.has(template)?template:null;
}

module.exports={documentTemplate};
