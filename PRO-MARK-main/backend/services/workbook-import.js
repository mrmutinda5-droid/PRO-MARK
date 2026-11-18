const fs = require('fs/promises');
const zlib = require('zlib');

// XLSX/XLSM files are ZIP containers. This tiny reader extracts only the XML
// parts needed for detection/import, avoiding a full ExcelJS workbook parse.
function zipEntries(buffer){
  const eocdSig=0x06054b50;
  let eocd=-1;
  for(let i=buffer.length-22;i>=0;i--){if(buffer.readUInt32LE(i)===eocdSig){eocd=i;break;}}
  if(eocd<0)throw new Error('The uploaded file is not a valid XLSX/XLSM workbook.');
  const count=buffer.readUInt16LE(eocd+10),dirOffset=buffer.readUInt32LE(eocd+16);
  const map=new Map();let p=dirOffset;
  for(let i=0;i<count;i++){
    if(buffer.readUInt32LE(p)!==0x02014b50)throw new Error('The workbook ZIP directory is invalid.');
    const method=buffer.readUInt16LE(p+10),compressed=buffer.readUInt32LE(p+20),nameLen=buffer.readUInt16LE(p+28),extraLen=buffer.readUInt16LE(p+30),commentLen=buffer.readUInt16LE(p+32),localOffset=buffer.readUInt32LE(p+42);
    const name=buffer.subarray(p+46,p+46+nameLen).toString('utf8');
    map.set(name,{method,compressed,localOffset});
    p+=46+nameLen+extraLen+commentLen;
  }
  return {buffer,map};
}
function zipRead(zip,name){
  const e=zip.map.get(name);if(!e)return null;
  const p=e.localOffset;
  if(zip.buffer.readUInt32LE(p)!==0x04034b50)throw new Error('The workbook contains an invalid ZIP entry.');
  const nameLen=zip.buffer.readUInt16LE(p+26),extraLen=zip.buffer.readUInt16LE(p+28);
  const data=zip.buffer.subarray(p+30+nameLen+extraLen,p+30+nameLen+extraLen+e.compressed);
  if(e.method===0)return data;
  if(e.method===8)return zlib.inflateRawSync(data);
  throw new Error(`Unsupported workbook compression method for ${name}.`);
}
const decodeXml=(value='')=>String(value).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
const stripTags=s=>decodeXml(String(s||'').replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g,'$1').replace(/<[^>]+>/g,''));
const attr=(attrs,name)=>{const m=String(attrs||'').match(new RegExp(`\\b${name}="([^"]*)"`));return m?decodeXml(m[1]):'';};
const colNumber=ref=>{const letters=String(ref||'').match(/^[A-Z]+/i)?.[0]?.toUpperCase()||'';let n=0;for(const ch of letters)n=n*26+(ch.charCodeAt(0)-64);return n;};
async function openWorkbook(filePath){return zipEntries(await fs.readFile(filePath));}
function workbookSheetMap(zip){
  const workbook=zipRead(zip,'xl/workbook.xml')?.toString('utf8')||'';const rels=zipRead(zip,'xl/_rels/workbook.xml.rels')?.toString('utf8')||'';const relMap=new Map();
  for(const m of rels.matchAll(/<Relationship\b([^>]*)\/>/g))relMap.set(attr(m[1],'Id'),attr(m[1],'Target'));
  const map=new Map();for(const tag of workbook.match(/<sheet\b[^>]*>/g)||[]){const name=attr(tag,'name'),rid=attr(tag,'r:id');let target=relMap.get(rid)||'';if(target.startsWith('/'))target=target.slice(1);if(!target.startsWith('xl/'))target=`xl/${target.replace(/^\.\//,'')}`;map.set(name,target);}return map;
}
function sharedStrings(zip){const file=zipRead(zip,'xl/sharedStrings.xml');if(!file)return [];const xml=file.toString('utf8'),out=[];for(const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))out.push(stripTags(m[1]));return out;}
function readSheetRows(zip,sheetPath,strings){
  const file=zipRead(zip,sheetPath);if(!file)throw new Error(`Worksheet ${sheetPath} is missing from the workbook.`);const xml=file.toString('utf8');const rows=[];const sheetData=(xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)||[])[1]||'';
  for(const rm of sheetData.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)){const cells=[];for(const cm of rm[2].matchAll(/<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/g)){const attrs=cm[1],body=cm[2]||'',idx=colNumber(attr(attrs,'r'));if(!idx)continue;const type=attr(attrs,'t'),vm=body.match(/<v>([\s\S]*?)<\/v>/),inline=body.match(/<is>([\s\S]*?)<\/is>/);let value='';if(type==='s'&&vm)value=strings[Number(decodeXml(vm[1]))]??'';else if(type==='inlineStr'&&inline)value=stripTags(inline[1]);else if(type==='str'&&vm)value=decodeXml(vm[1]);else if(vm)value=decodeXml(vm[1]);else if(inline)value=stripTags(inline[1]);cells[idx]=value;}rows.push(cells);}return rows;
}
function normHeader(v){return cleanHeader(v).toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();}
function cleanHeader(v){return String(v??'').replace(/\s+/g,' ').trim();}
function findSheet(map,aliases){const wanted=aliases.map(x=>normHeader(x));for(const [name,path] of map){if(wanted.includes(normHeader(name)))return path;}for(const [name,path] of map){const n=normHeader(name);if(wanted.some(w=>n.includes(w)||w.includes(n)))return path;}return null;}
function headerRow(rows,aliases,limit=12){const wanted=aliases.map(x=>normHeader(x));for(let i=0;i<Math.min(limit,rows.length);i++){const row=rows[i]||[];let hits=0;for(const cell of row){const n=normHeader(cell);if(wanted.some(w=>n===w||n.includes(w)||w.includes(n)))hits++;}if(hits>=Math.min(2,wanted.length))return i;}return -1;}
function headerMap(row){const m=new Map();(row||[]).forEach((v,i)=>{const n=normHeader(v);if(n)m.set(n,i);});return m;}
function findCol(hm,aliases){for(const a of aliases){const w=normHeader(a);for(const [h,i] of hm){if(h===w||h.includes(w)||w.includes(h))return i;}}return undefined;}
function canonicalTeachers(rows){
  const hi=headerRow(rows,['STAFF NO','STAFF NUMBER','STAFF ID','USERNAME','TEACHER NAME','NAME','ROLE','SUBJECTS','SUBJECT','CLASS','CLASSES'],15);
  const h=hi>=0?headerMap(rows[hi]):new Map();
  const staff=findCol(h,['STAFF NO','STAFF NUMBER','STAFF ID','USERNAME','TSC NO','CODE']);
  const name=findCol(h,['TEACHER NAME','FULL NAME','NAME','TEACHER']);
  const role=findCol(h,['ROLE','TEACHER ROLE','DESIGNATION']);
  const subjects=findCol(h,['SUBJECTS','SUBJECT / CLASS','SUBJECT CLASS','ASSIGNMENTS','TEACHING SUBJECTS']);
  const cls=findCol(h,['CLASS','CLASSES','CLASS REF','CLASS REFERENCE','CLASS TEACHER CLASS']);
  const out=[[],];
  for(let i=(hi>=0?hi+1:1);i<rows.length;i++){
    const v=rows[i]||[],u=String(v[staff??1]??'').trim(),full=String(v[name??2]??'').trim();
    if(!u&&!full)continue;
    out.push(['',u,full,String(v[role??3]??'').trim(),'',String(v[subjects??5]??'').trim(),String(v[cls??6]??'').trim()]);
  }
  out[0]=['','STAFF NO','TEACHER NAME','ROLE','','SUBJECTS','CLASS'];
  return out;
}
function canonicalMarks(rows){
  const hi=headerRow(rows,[
    'TEACHER','TEACHER NAME','STAFF NO','GRADE','CLASS','STREAM','SUBJECT',
    'LEARNING AREA','STUDENT','STUDENT NAME','LEARNER','LEARNER NAME','NAME',
    'ADMISSION NO','ADM NO','ADM NUMBER','ADMISSION NUMBER','ASS NO','ASSESSMENT NO',
    'ASSESSMENT NUMBER','PUPIL NO','REG NO','REGISTRATION NO','OPENER','MID TERM',
    'END TERM','EXAM','ASSESSMENT'
  ],15);
  const h=hi>=0?headerMap(rows[hi]):new Map();
  const teacher=findCol(h,['TEACHER NAME','TEACHER','STAFF NO','STAFF NUMBER','TEACHER CODE']);
  const grade=findCol(h,['GRADE','LEVEL','FORM']);
  const explicitClass=findCol(h,['CLASS','CLASS NAME','CLASS/STREAM']);
  const stream=findCol(h,['STREAM','STREAM NAME']);
  const subject=findCol(h,['SUBJECT','LEARNING AREA','LEARNING AREA / SUBJECT']);
  const student=findCol(h,['STUDENT NAME','LEARNER NAME','STUDENT','LEARNER','NAME']);
  const admission=findCol(h,['ADMISSION NO','ADM NO','ADM NUMBER','ADMISSION NUMBER','PUPIL NO','REG NO','REGISTRATION NO']);
  const assNo=findCol(h,['ASS NO','ASSESSMENT NO','ASSESSMENT NUMBER','ASSESSMENT ID','ASSESSMENT CODE']);
  if(subject===undefined||student===undefined)throw new Error('Could not identify Subject/Learning Area and Student/Learner Name columns in the MARK ENTRY sheet.');
  if(grade===undefined&&explicitClass===undefined)throw new Error('Could not identify Grade/Class in the MARK ENTRY sheet.');
  const used=new Set([teacher,grade,explicitClass,stream,subject,student,admission,assNo].filter(x=>x!==undefined));
  const assessmentSource=[];
  if(hi>=0){
    const row=rows[hi]||[];
    row.forEach((cell,i)=>{
      if(used.has(i))return;
      const label=cleanHeader(cell);const n=normHeader(label);if(!label)return;
      if(/AVERAGE|AVG|MEAN|TERM AVERAGE/.test(n))return;
      const looksMain=/OPENER|OPENING|MID ?TERM|MIDTERM|END ?TERM|ENDTERM/.test(n);
      const looksOther=/CAT|TEST|EXAM|ASSESSMENT/.test(n);
      if(looksMain||looksOther)assessmentSource.push({col:i,label});
    });
  }
  const out=[[
    '','TEACHER','GRADE','SUBJECT','STUDENT','ADMISSION NO','ASS NO','CLASS','STREAM',
    ...assessmentSource.map(x=>x.label)
  ]];
  for(let i=(hi>=0?hi+1:1);i<rows.length;i++){
    const v=rows[i]||[];
    const g=String(v[grade??explicitClass]??'').trim();
    const cls=String(v[explicitClass??grade]??'').trim();
    const stu=String(v[student]??'').trim();
    const sub=String(v[subject]??'').trim();
    if(!sub||!stu||(!g&&!cls))continue;
    const classValue=cls||g;
    const gradeValue=g||classValue;
    out.push([
      '',
      String(v[teacher??1]??'').trim(),
      gradeValue,
      sub,
      stu,
      String(v[admission]??'').trim(),
      String(v[assNo]??'').trim(),
      classValue,
      String(v[stream]??'').trim(),
      ...assessmentSource.map(x=>v[x.col])
    ]);
  }
  return out;
}

function detectHeaderIndex(rows, groups, limit=20){
  const wanted=groups.map(x=>normHeader(x));
  for(let i=0;i<Math.min(limit,rows.length);i++){
    const cells=(rows[i]||[]).map(normHeader);
    const hits=wanted.reduce((n,w)=>n+(cells.some(c=>c===w||c.includes(w)||w.includes(c))?1:0),0);
    if(hits>=2)return i;
  }
  return -1;
}
function canonicalLearners(rows,sourceSheet=''){
  const hi=detectHeaderIndex(rows,['LEARNER NAME','STUDENT NAME','STUDENT','LEARNER','NAME','ADMISSION NO','CLASS','GRADE','ASSESSMENT NO','GENDER','DATE OF BIRTH'],20);
  if(hi<0)return [];
  const hm=headerMap(rows[hi]||[]);
  const name=findCol(hm,['LEARNER NAME','STUDENT NAME','STUDENT','LEARNER','NAME']);
  const admission=findCol(hm,['ADMISSION NO','ADM NO','ADM NUMBER','ADMISSION NUMBER','PUPIL NO','REG NO','REGISTRATION NO']);
  const assNo=findCol(hm,['ASS NO','ASSESSMENT NO','ASSESSMENT NUMBER','ASSESSMENT ID','ASSESSMENT CODE']);
  const cls=findCol(hm,['CLASS NAME','CLASS','CLASS/STREAM','GRADE','LEVEL','FORM']);
  const stream=findCol(hm,['STREAM','STREAM NAME']);
  const gender=findCol(hm,['GENDER','SEX']);
  const dob=findCol(hm,['DATE OF BIRTH','DOB','BIRTH DATE','BIRTHDATE']);
  const phone=findCol(hm,['PARENT PHONE','PARENT CONTACT','GUARDIAN PHONE','GUARDIAN CONTACT','PHONE','MOBILE']);
  if(name===undefined)return [];
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const v=rows[i]||[],student=cleanHeader(v[name]);
    if(!student)continue;
    out.push({source_sheet:sourceSheet,student,admissionNo:admission===undefined?'':cleanHeader(v[admission]),assNo:assNo===undefined?'':cleanHeader(v[assNo]),className:cls===undefined?'':cleanHeader(v[cls]),stream:stream===undefined?'':cleanHeader(v[stream]),gender:gender===undefined?'':cleanHeader(v[gender]),dateOfBirth:dob===undefined?'':cleanHeader(v[dob]),parentPhone:phone===undefined?'':cleanHeader(v[phone])});
  }
  return out;
}

async function parseRelevantWorkbook(filePath){
  const zip=await openWorkbook(filePath),map=workbookSheetMap(zip),strings=sharedStrings(zip);
  const all=[];
  for(const [name,sheetPath] of map){
    try{all.push({name,path:sheetPath,rows:readSheetRows(zip,sheetPath,strings)});}catch(e){all.push({name,path:sheetPath,rows:[],error:e.message});}
  }
  // Prefer conventional names, but do not require them. If a workbook calls its
  // sheets something else, inspect the header structure and use the matching data.
  let teacherSheets=all.filter(x=>findSheet(new Map([[x.name,x.path]]),['TEACHERS','STAFF','TEACHER LIST','STAFF LIST']));
  let markSheets=all.filter(x=>findSheet(new Map([[x.name,x.path]]),['MARK ENTRY','MARKS','MARK ENTRY SHEET','MARKS ENTRY','RESULTS','RESULTS ENTRY']));
  if(!teacherSheets.length)teacherSheets=all.filter(x=>detectHeaderIndex(x.rows,['TEACHER NAME','TEACHER','STAFF NO','ROLE','SUBJECTS','CLASS'],20)>=0);
  if(!markSheets.length)markSheets=all.filter(x=>detectHeaderIndex(x.rows,['SUBJECT','LEARNER NAME','STUDENT NAME','CLASS','GRADE','OPENER','END TERM','MARK'],20)>=0 && !teacherSheets.includes(x));
  if(!teacherSheets.length)throw new Error('Could not identify a teacher/staff sheet anywhere in the workbook. ZELIMU CBC inspected all worksheet names and headers.');
  if(!markSheets.length)throw new Error('Could not identify a marks/learner-results sheet anywhere in the workbook. ZELIMU CBC inspected all worksheet names and headers.');
  const teacherRows=[['','STAFF NO','TEACHER NAME','ROLE','','SUBJECTS','CLASS']];
  for(const sh of teacherSheets){const rows=canonicalTeachers(sh.rows);for(let i=1;i<rows.length;i++)teacherRows.push(rows[i]);}
  let markRows=null;
  for(const sh of markSheets){
    const rows=canonicalMarks(sh.rows);
    if(rows.length){
      if(!markRows)markRows=[rows[0]];
      for(let i=1;i<rows.length;i++)markRows.push(rows[i]);
    }
  }
  markRows=markRows||[['','TEACHER','GRADE','SUBJECT','STUDENT','ADMISSION NO','ASS NO','CLASS','STREAM']];
  if(teacherRows.length<=1)throw new Error('A teacher/staff sheet was found, but no usable teacher rows were detected.');
  if(markRows.length<=1)throw new Error('A marks/results sheet was found, but no usable learner/subject rows were detected.');
  // Any other worksheet that looks like a learner register is also read and merged.
  // This prevents a workbook from losing learners merely because their roster is on
  // a separate sheet from the marks.
  const learnerRows=[];
  const used=new Set([...teacherSheets,...markSheets].map(x=>x.name));
  for(const sh of all){if(used.has(sh.name))continue;learnerRows.push(...canonicalLearners(sh.rows,sh.name));}
  return {teachers:teacherRows,marks:markRows,learners:learnerRows,sheets:all.map(x=>x.name),sheet_details:all.map(x=>({name:x.name,rows:Math.max(0,(x.rows||[]).length),columns:Math.max(0,...(x.rows||[]).map(r=>(r||[]).length),0),recognized_as_teacher:teacherSheets.some(t=>t.name===x.name),recognized_as_marks:markSheets.some(t=>t.name===x.name),recognized_as_learner_roster:learnerRows.some(r=>r.source_sheet===x.name)}))};
}

module.exports={parseRelevantWorkbook};
