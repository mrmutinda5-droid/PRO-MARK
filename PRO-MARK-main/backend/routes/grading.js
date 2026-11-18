const express=require('express'),db=require('../db');
const {authenticate,roles,schoolBoundary}=require('../middleware/auth');
const {assertBelongs}=require('../services/tenant');
const router=express.Router();router.use(authenticate);
function validateBands(bands){
 if(!Array.isArray(bands)||!bands.length)throw Error('At least one grading band is required');
 const sorted=bands.map(b=>({label:String(b.label||'').trim(),min:Number(b.min_mark),max:Number(b.max_mark),points:Number(b.points||0),descriptor:String(b.descriptor||''),remark:String(b.remark||'')}));
 if(sorted.some(b=>!b.label||!Number.isFinite(b.min)||!Number.isFinite(b.max)||b.min<0||b.max>100||b.min>b.max))throw Error('Every grading band needs a label and valid min/max marks between 0 and 100');
 sorted.sort((a,b)=>a.min-b.min);
 if(sorted[0].min!==0||sorted[sorted.length-1].max!==100)throw Error('Grading bands must cover the full 0 to 100 mark range');
 const integerBands=sorted.every(b=>Number.isInteger(b.min)&&Number.isInteger(b.max));
 for(let i=1;i<sorted.length;i++){
  const prev=sorted[i-1],cur=sorted[i];
  if(cur.min<=prev.max+0.0001)throw Error('Grading bands overlap');
  if(integerBands
      ? cur.min!==prev.max+1
      : Math.round((cur.min-prev.max)*10)/10>0.1+0.000001
    )throw Error('Grading bands contain a gap');
 }
 return sorted;
}
router.get('/:schoolId/systems',schoolBoundary,async(req,res)=>{try{const q=await db.query(`
  SELECT gs.*,
    COALESCE(json_agg(gb ORDER BY gb.min_mark DESC) FILTER(WHERE gb.id IS NOT NULL),'[]') bands,
    COALESCE((SELECT json_agg(DISTINCT ac.level_id) FILTER(WHERE ac.level_id IS NOT NULL)
      FROM assessment_configurations ac WHERE ac.grading_system_id=gs.id AND ac.class_id IS NULL),'[]') target_level_ids,
    COALESCE((SELECT json_agg(DISTINCT ac.class_id) FILTER(WHERE ac.class_id IS NOT NULL)
      FROM assessment_configurations ac WHERE ac.grading_system_id=gs.id),'[]') target_class_ids
  FROM grading_systems gs LEFT JOIN grading_bands gb ON gb.grading_system_id=gs.id
  WHERE gs.school_id=$1 AND gs.is_active=true GROUP BY gs.id ORDER BY gs.name`,[req.params.schoolId]);res.json(q.rows)}catch(e){console.error('Unable to load grading systems:',e);res.status(500).json({error:'Unable to load grading systems'});}});

router.post('/:schoolId/systems',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},c=await db.pool.connect();try{const name=String(b.name||'').trim(),code=String(b.code||'').trim().toUpperCase(),bands=validateBands(b.bands);if(!name||!code)throw Error('Grading system name and code are required');const classIds=Array.isArray(b.target_class_ids)?b.target_class_ids.filter(Boolean):[];const levelIds=Array.isArray(b.target_level_ids)?b.target_level_ids.filter(Boolean):[];if(!classIds.length&&!levelIds.length)throw Error('Select at least one target class or level.');await c.query('BEGIN');const s=(await c.query(`INSERT INTO grading_systems(school_id,name,code,description) VALUES($1,$2,$3,$4) RETURNING *`,[req.params.schoolId,name,code,String(b.description||'')])).rows[0];for(const x of bands)await c.query(`INSERT INTO grading_bands(grading_system_id,label,min_mark,max_mark,points,descriptor,remark) VALUES($1,$2,$3,$4,$5,$6,$7)`,[s.id,x.label,x.min,x.max,x.points,x.descriptor,x.remark]);for(const classId of classIds){await assertBelongs('classes',classId,req.params.schoolId);await c.query(`INSERT INTO assessment_configurations(school_id,class_id,grading_system_id,include_in_term_average,include_in_merit) VALUES($1,$2,$3,true,true)`,[req.params.schoolId,classId,s.id]);}for(const levelId of levelIds){await assertBelongs('school_levels',levelId,req.params.schoolId);await c.query(`INSERT INTO assessment_configurations(school_id,level_id,grading_system_id,include_in_term_average,include_in_merit) VALUES($1,$2,$3,true,true)`,[req.params.schoolId,levelId,s.id]);}await c.query('COMMIT');res.status(201).json(s);}catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.code==='23505'?409:400).json({error:e.code==='23505'?'That grading system code already exists.':e.message});}finally{c.release();}});

router.patch('/:schoolId/systems/:systemId',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body||{},c=await db.pool.connect();try{await assertBelongs('grading_systems',req.params.systemId,req.params.schoolId);const name=String(b.name||'').trim(),code=String(b.code||'').trim().toUpperCase(),bands=validateBands(b.bands);if(!name||!code)throw Error('Grading system name and code are required');const classIds=Array.isArray(b.target_class_ids)?b.target_class_ids.filter(Boolean):null;const levelIds=Array.isArray(b.target_level_ids)?b.target_level_ids.filter(Boolean):null;if(classIds!==null&&levelIds!==null&&!classIds.length&&!levelIds.length)throw Error('Select at least one target class or level.');await c.query('BEGIN');const s=(await c.query(`UPDATE grading_systems SET name=$3,code=$4,description=$5 WHERE id=$1 AND school_id=$2 RETURNING *`,[req.params.systemId,req.params.schoolId,name,code,String(b.description||'')])).rows[0];if(!s)throw Object.assign(new Error('Grading system not found'),{status:404});await c.query('DELETE FROM grading_bands WHERE grading_system_id=$1',[s.id]);for(const x of bands)await c.query(`INSERT INTO grading_bands(grading_system_id,label,min_mark,max_mark,points,descriptor,remark) VALUES($1,$2,$3,$4,$5,$6,$7)`,[s.id,x.label,x.min,x.max,x.points,x.descriptor,x.remark]);if(classIds!==null||levelIds!==null){await c.query(`DELETE FROM assessment_configurations WHERE school_id=$1 AND grading_system_id=$2 AND section_id IS NULL AND subject_id IS NULL AND assessment_id IS NULL`,[req.params.schoolId,s.id]);for(const classId of (classIds||[])){await assertBelongs('classes',classId,req.params.schoolId);await c.query(`INSERT INTO assessment_configurations(school_id,class_id,grading_system_id,include_in_term_average,include_in_merit) VALUES($1,$2,$3,true,true)`,[req.params.schoolId,classId,s.id]);}for(const levelId of (levelIds||[])){await assertBelongs('school_levels',levelId,req.params.schoolId);await c.query(`INSERT INTO assessment_configurations(school_id,level_id,grading_system_id,include_in_term_average,include_in_merit) VALUES($1,$2,$3,true,true)`,[req.params.schoolId,levelId,s.id]);}}await c.query('COMMIT');res.json({ok:true,id:s.id,name:s.name,code:s.code});}catch(e){try{await c.query('ROLLBACK')}catch{}res.status(e.status || (e.code==='23505'?409:400)).json({error:e.code==='23505'?'That grading system code already exists.':e.message});}finally{c.release();}});
router.post('/:schoolId/configurations',schoolBoundary,roles('SCHOOL_ADMIN','ADMIN'),async(req,res)=>{const b=req.body;try{await assertBelongs('grading_systems',b.grading_system_id,req.params.schoolId);for(const [t,k] of [['school_sections','section_id'],['school_levels','level_id'],['classes','class_id'],['subjects','subject_id'],['assessments','assessment_id']])if(b[k]){if(t==='school_sections'){const q=await db.query('SELECT id FROM school_sections WHERE id=$1 AND school_id=$2',[b[k],req.params.schoolId]);if(!q.rows[0])throw Object.assign(new Error('Section does not belong to this school'),{status:403});}else await assertBelongs(t,b[k],req.params.schoolId);}const q=await db.query(`INSERT INTO assessment_configurations(school_id,section_id,level_id,class_id,subject_id,assessment_id,grading_system_id,include_in_term_average,include_in_merit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.params.schoolId,b.section_id||null,b.level_id||null,b.class_id||null,b.subject_id||null,b.assessment_id||null,b.grading_system_id,b.include_in_term_average!==false,b.include_in_merit!==false]);res.status(201).json(q.rows[0]);}catch(e){res.status(e.status||400).json({error:e.message});}});

/* ZELIMU GRADING SYSTEM REMOVE */
router.delete(
 '/:schoolId/systems/:systemId',
 schoolBoundary,
 roles('SCHOOL_ADMIN','ADMIN'),
 async(req,res)=>{
  try{
   const result=await db.query(`
    UPDATE grading_systems
    SET is_active=false
    WHERE id=$1 AND school_id=$2
    RETURNING id,name
   `,[req.params.systemId,req.params.schoolId]);

   if(!result.rows.length)
    return res.status(404).json({error:'Grading system not found'});

   res.json({
    success:true,
    message:'Grading system removed from active use',
    system:result.rows[0]
   });
  }catch(e){
   res.status(500).json({error:e.message});
  }
 }
);

module.exports=router;
