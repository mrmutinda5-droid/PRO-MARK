/**
 * Controlled Kauti workbook migration.
 * Default mode is DRY RUN. Nothing is written unless --commit is supplied.
 *
 * Source supported by this importer: the uploaded KAUTI SCHOOL 2026 TERM 3 MARKS workbook,
 * especially its TEACHERS and MARK ENTRY sheets. It intentionally does not import passwords/passkeys.
 */
require("dotenv").config();
const ExcelJS=require("exceljs"),crypto=require("crypto"),{Pool}=require("pg");
const path=require("path");
const SOURCE=process.env.KAUTI_WORKBOOK||path.join(__dirname,"..","legacy_reference","KAUTI_JUNIOR_SCHOOL","KAUTI SCHOOL 2026 TERM 3 MARKS (SANITIZED).xlsx");
const COMMIT=process.argv.includes("--commit");
const SCHOOL_CODE=(process.env.KAUTI_SCHOOL_CODE||"KAUTI").toUpperCase();
const SCHOOL_NAME=process.env.KAUTI_SCHOOL_NAME||"KAUTI JUNIOR SCHOOL";
const YEAR_LABEL=process.env.KAUTI_YEAR||"2026";
const client=new Pool({connectionString:process.env.DATABASE_URL});
const clean=v=>String(v??"").trim();
const key=v=>clean(v).toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_|_$/g,"");
const id=v=>crypto.createHash("sha256").update(v).digest("hex").slice(0,10).toUpperCase();
function classFromRef(ref){
 const x=key(ref);
 const m=x.match(/(?:FINAL_)?(?:AVERAGE_)?(?:PP1|PP2|GRADE_[1-9]A?B?)/);
 if(!m)return null;
 const g=m[0].replace(/^FINAL_|^AVERAGE_/,"");
 return gradeInfo(g);
}
function teacherRole(role){
 const x=key(role);
 if(x.includes("HEADTEACHER")) return "HEADTEACHER";
 if(x.includes("SENIOR_TEACHER")) return "SENIOR_TEACHER";
 if(x.includes("CLASSTEACHER")) return "CLASS_TEACHER";
 return "TEACHER";
}
function gradeInfo(g){const x=key(g);if(x.startsWith("GRADE9A"))return {level:"GRADE_9",stream:"A"};if(x.startsWith("GRADE9B"))return {level:"GRADE_9",stream:"B"};const m=x.match(/^(PP1|PP2|GRADE_[1-9])/);return m?{level:m[1],stream:""}:null;}
async function one(sql,params=[]){const r=await client.query(sql,params);return r.rows[0]||null;}
async function many(sql,params=[]){return (await client.query(sql,params)).rows;}
async function main(){
 console.log(`KAUTI workbook: ${SOURCE}`);console.log(`Mode: ${COMMIT?"COMMIT":"DRY RUN"}`);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(SOURCE);
 const teacherRows=[];const tw=wb.getWorksheet("TEACHERS");if(tw){tw.eachRow((row,n)=>{if(n===1)return;const vals=row.values||[];const username=clean(vals[1]), name=clean(vals[2]), role=key(vals[3]), subjects=clean(vals[5]), classRef=clean(vals[6]);
 if(!username || !name || username.toUpperCase()=== "TEACHER" || name.toUpperCase()=== "TEACHER" || name.toUpperCase()==="ADMIN") return;
 teacherRows.push({username,name,role,subjects,classRef});});}
 const markRows=[];const mw=wb.getWorksheet("MARK ENTRY");if(!mw)throw Error("MARK ENTRY sheet not found");mw.eachRow((row,n)=>{if(n<=2)return;const v=row.values||[];const grade=clean(v[2]),subject=clean(v[3]),student=clean(v[4]);if(!grade||!subject||!student)return;markRows.push({teacher:clean(v[1]),grade,subject,student,opener:v[5],mid:v[6],end:v[7],average:v[8]});});
 const counts={teachers:new Map(),subjects:new Map(),classes:new Map(),learners:new Map(),assessments:3,marks:0};
 const unique=(map,k)=>{map.set(k,(map.get(k)||0)+1);};
 teacherRows.forEach(t=>unique(counts.teachers,t.username));markRows.forEach(r=>{const gi=gradeInfo(r.grade);if(gi)unique(counts.classes,`${gi.level}|${gi.stream}`);unique(counts.subjects,key(r.subject));unique(counts.learners,`${r.grade}|${r.student}`);});
 if(!COMMIT){console.log({teachers:counts.teachers.size,classes:counts.classes.size,learners:counts.learners.size,subjects:counts.subjects.size,assessments:3,marks:markRows.reduce((n,r)=>n+(r.opener!==null&&clean(r.opener)!==""?1:0)+(r.mid!==null&&clean(r.mid)!==""?1:0)+(r.end!==null&&clean(r.end)!==""?1:0),0)});console.log("DRY RUN complete. Re-run with --commit to write to ZELIMU CBC.");return;}
 await client.query("BEGIN");
 let school=await one(`SELECT id FROM schools WHERE code=$1`,[SCHOOL_CODE]);
 if(!school){const t=await one(`SELECT id FROM school_templates WHERE code='JUNIOR'`);school=await one(`INSERT INTO schools(code,name,template_id) VALUES($1,$2,$3) RETURNING id`,[SCHOOL_CODE,SCHOOL_NAME,t.id]);await client.query(`INSERT INTO school_identity(school_id,motto) VALUES($1,'') ON CONFLICT(school_id) DO NOTHING`,[school.id]);await client.query(`INSERT INTO school_sections(school_id,template_section_id,code,name,sort_order) SELECT $1,id,code,name,sort_order FROM template_sections WHERE template_id=$2`,[school.id,t.id]);await client.query(`INSERT INTO school_levels(school_section_id,template_level_id,code,name,sort_order) SELECT ss.id,tl.id,tl.code,tl.name,tl.sort_order FROM school_sections ss JOIN template_levels tl ON tl.template_section_id=ss.template_section_id WHERE ss.school_id=$1`,[school.id]);}
 const sid=school.id;
 const year=await one(`INSERT INTO academic_years(school_id,year_label,status) VALUES($1,$2,'ACTIVE') ON CONFLICT(school_id,year_label) DO UPDATE SET year_label=EXCLUDED.year_label RETURNING id`,[sid,YEAR_LABEL]);
 const term=await one(`INSERT INTO terms(school_id,academic_year_id,term_no,name,status) VALUES($1,$2,3,'Term 3','ACTIVE') ON CONFLICT(academic_year_id,term_no) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[sid,year.id]);
 const levels=await many(`SELECT sl.id,sl.code FROM school_levels sl JOIN school_sections ss ON ss.id=sl.school_section_id WHERE ss.school_id=$1`,[sid]);const levelMap=new Map(levels.map(x=>[x.code,x.id]));
 const teachers=new Map();
 for(const t of teacherRows){if(!t.username)continue;const name=t.name||t.username;const parts=name.split(/\s+/);const q=await one(`INSERT INTO teachers(school_id,staff_no,first_name,last_name,email,imported_role) VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(school_id,staff_no) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,imported_role=EXCLUDED.imported_role RETURNING id`,[sid,t.username,parts[0]||name,parts.slice(1).join(" ")||"Teacher",teacherRole(t.role)]);teachers.set(t.username,q.id);}
 const subjects=new Map();
 async function subject(name){const code=key(name);if(subjects.has(code))return subjects.get(code);const q=await one(`INSERT INTO subjects(school_id,code,name) VALUES($1,$2,$3) ON CONFLICT(school_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[sid,code,name]);subjects.set(code,q.id);return q.id;}
 const classes=new Map();
 async function clazz(g){const gi=gradeInfo(g);if(!gi||!levelMap.has(gi.level))return null;const ck=`${gi.level}|${gi.stream}`;if(classes.has(ck))return classes.get(ck);const level=levelMap.get(gi.level);const q=await one(`INSERT INTO classes(school_id,school_level_id,name,stream) VALUES($1,$2,$3,$4) ON CONFLICT(school_id,name,stream) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[sid,level,gi.stream?`Grade 9`:gi.level==='PP1'?'PP1':gi.level==='PP2'?'PP2':gi.level.replace('GRADE_','Grade '),gi.stream]);classes.set(ck,q.id);return q.id;}
 for(const tr of teacherRows){
   const teacherId=teachers.get(tr.username); if(!teacherId) continue;
   const pairs=tr.subjects.split(',').map(x=>x.trim()).filter(Boolean);
   for(const pair of pairs){
     const m=pair.match(/^([^|]+)\\|(.+)$/); if(!m) continue;
     const cls=await clazz(m[1]); const sub=await subject(m[2]); if(!cls) continue;
     for(const termNo of [1,2,3]){
       const termRow=await one(`SELECT id FROM terms WHERE academic_year_id=$1 AND term_no=$2`,[year.id,termNo]);
       if(termRow) await client.query(`INSERT INTO teacher_subject_assignments(school_id,teacher_id,subject_id,class_id,academic_year_id,term_id,is_class_teacher) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[sid,teacherId,sub,cls,year.id,termRow.id,teacherRole(tr.role)==='CLASS_TEACHER']);
     }
   }
   const ct=classFromRef(tr.classRef);
   if(ct){
     const cls=await clazz(tr.classRef);
     if(cls && teacherRole(tr.role)==='CLASS_TEACHER') for(const termNo of [1,2,3]){
       const termRow=await one(`SELECT id FROM terms WHERE academic_year_id=$1 AND term_no=$2`,[year.id,termNo]);
       if(termRow) await client.query(`INSERT INTO class_teacher_assignments(school_id,teacher_id,class_id,academic_year_id,term_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[sid,teacherId,cls,year.id,termRow.id]);
     }
   }
 }
 const assessments={};
const isTerm3 = Number(term.term_no)===3;
const hasMidTermMarks=markRows.some(r=>r.mid!==null&&clean(r.mid)!==''&&!Number.isNaN(Number(r.mid)));
const importedAssessmentSpecs=isTerm3 ? [["OPENER","OPENER",1],...(hasMidTermMarks?[["MIDTERM","MID_TERM",2]]:[]),["END TERM","END_TERM",hasMidTermMarks?3:2]] : [["OPENER","OPENER",1],["MIDTERM","MID_TERM",2],["END TERM","END_TERM",3]];
for(const [name,type,order] of importedAssessmentSpecs){
 const a =
  await one(
    `INSERT INTO assessments(
      school_id,academic_year_id,term_id,name,assessment_type,
      max_mark,weight,include_in_final,assessment_order,status
    )
    VALUES($1,$2,$3,$4,$5,100,0,true,$6,'OPEN')
    ON CONFLICT DO NOTHING
    RETURNING id`,
    [sid,year.id,term.id,name,type,order]
  )
  ||
  await one(
    `SELECT id FROM assessments
     WHERE school_id=$1
       AND academic_year_id=$2
       AND term_id=$3
       AND assessment_type=$4`,
    [sid,year.id,term.id,type]
  );

  if(!a || !a.id){
    throw new Error(`Unable to create/find ${type} assessment`);
  }

  assessments[type]=a.id;
}
 const juniorSection=await one(`SELECT id FROM school_sections WHERE school_id=$1 AND code='JUNIOR'`,[sid]);
 const grading=await one(`INSERT INTO grading_systems(school_id,name,code,description) VALUES($1,'Junior CBC','CBC','Imported Kauti Junior/CBC grading reference') ON CONFLICT(school_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[sid]);
 const bands=[['EE',80,100,4,'Exceeding Expectations','Excellent'],['ME',60,79.99,3,'Meeting Expectations','Good'],['AE',40,59.99,2,'Approaching Expectations','Developing'],['BE',0,39.99,1,'Below Expectations','Needs support']];
 for(const b of bands) await client.query(`INSERT INTO grading_bands(grading_system_id,label,min_mark,max_mark,points,descriptor,remark) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM grading_bands WHERE grading_system_id=$1 AND label=$2)`,[grading.id,...b]);
 for(const section of ['JUNIOR']) await client.query(`INSERT INTO report_templates(school_id,section_code,name,template_type,primary_color,secondary_color) VALUES($1,$2,$3,'JUNIOR_A4','#17365D','#D9A441') ON CONFLICT(school_id,section_code) DO NOTHING`,[sid,section,'Kauti Junior A4 Report']);

 if(!assessments.OPENER || !assessments.END_TERM || (!isTerm3 && !assessments.MID_TERM)){
   throw new Error(
     `Assessment UUID missing: OPENER=${assessments.OPENER}, MID_TERM=${assessments.MID_TERM}, END_TERM=${assessments.END_TERM}`
   );
 }
 const assessmentIds=(isTerm3 ? [assessments.OPENER,...(hasMidTermMarks?[assessments.MID_TERM]:[]),assessments.END_TERM] : [assessments.OPENER,assessments.MID_TERM,assessments.END_TERM]);
 if(assessmentIds.some(v=>typeof v!=="string" || !/^[0-9a-fA-F-]{36}$/.test(v))){
   throw new Error(`Invalid assessment UUID(s): ${JSON.stringify(assessments)}`);
 }

 let markCount=0;
 for(const r of markRows){const cls=await clazz(r.grade);if(!cls)continue;const sub=await subject(r.subject);let learner=await one(`SELECT id FROM learners WHERE school_id=$1 AND class_id=$2 AND UPPER(TRIM(first_name||' '||middle_name||' '||last_name))=$3`,[sid,cls,key(r.student).replace(/_/g,' ')]);if(!learner){const parts=r.student.split(/\s+/);const admission=`LEGACY-${id(`${YEAR_LABEL}|${r.grade}|${r.student}`)}`;learner=await one(`INSERT INTO learners(school_id,admission_no,first_name,middle_name,last_name,class_id) VALUES($1,$2,$3,'',$4,$5) ON CONFLICT(school_id,admission_no) DO UPDATE SET class_id=EXCLUDED.class_id RETURNING id`,[sid,admission,parts[0]||r.student,parts.slice(1).join(' ')||'Learner',cls]);}
 await client.query(`INSERT INTO learner_enrollments(school_id,learner_id,academic_year_id,class_id,status) VALUES($1,$2,$3,$4,'ACTIVE') ON CONFLICT(learner_id,academic_year_id) DO NOTHING`,[sid,learner.id,year.id,cls]);
 const teacherId=teachers.get(r.teacher);if(teacherId)await client.query(`INSERT INTO teacher_subject_assignments(school_id,teacher_id,subject_id,class_id,academic_year_id,term_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[sid,teacherId,sub,cls,year.id,term.id]);
 const importPairs=isTerm3 ? [[r.opener,assessments.OPENER],...(hasMidTermMarks?[[r.mid,assessments.MID_TERM]]:[]),[r.end,assessments.END_TERM]] : [[r.opener,assessments.OPENER],[r.mid,assessments.MID_TERM],[r.end,assessments.END_TERM]];
 for(const [val,aid] of importPairs){if(val===null||clean(val)===""||Number.isNaN(Number(val)))continue;const n=Number(val);if(n<0||n>100)continue;await client.query(`INSERT INTO marks(school_id,learner_id,subject_id,class_id,academic_year_id,term_id,assessment_id,mark,remark) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Imported from Kauti workbook') ON CONFLICT(learner_id,subject_id,assessment_id) DO UPDATE SET mark=EXCLUDED.mark,remark=EXCLUDED.remark,updated_at=now()`,[sid,learner.id,sub,cls,year.id,term.id,aid,n]);markCount++;}
 }
 await client.query(`INSERT INTO migration_runs(school_id,source_name,mode,status,completed_at,counts) VALUES($1,$2,'COMMIT','COMPLETED',now(),$3)`,[sid,path.basename(SOURCE),JSON.stringify({teachers:teacherRows.length,learners:counts.learners.size,subjects:counts.subjects.size,marks:markCount})]);
 await client.query("COMMIT");console.log(`Kauti migration committed. School ${SCHOOL_CODE}; imported marks: ${markCount}`);
}
main().catch(async e=>{try{await client.query("ROLLBACK")}catch{}console.error(e);process.exitCode=1}).finally(()=>client.end());
