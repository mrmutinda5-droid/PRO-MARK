const fs=require('fs');
const path=require('path');

function localPath(url){
  if(!url || /^data:/i.test(String(url))) return null;
  const raw=String(url);
  if(/^https?:\/\//i.test(raw)) return null;
  const p=path.join(__dirname,'..','..',raw.replace(/^\//,''));
  return fs.existsSync(p)?p:null;
}

function source(url){
  if(!url) return null;
  const value=String(url);
  if(/^data:image\/(png|jpe?g|webp);base64,/i.test(value)){
    try{return Buffer.from(value.split(',',2)[1],'base64');}catch{return null;}
  }
  return localPath(value);
}

function dataUrl(buffer,mime){
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

module.exports={localPath,source,dataUrl};
