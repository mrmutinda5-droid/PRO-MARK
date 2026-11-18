const db=require('../db');
async function schoolExists(schoolId){const q=await db.query('SELECT id,status FROM schools WHERE id=$1',[schoolId]);return q.rows[0]||null;}
async function assertBelongs(table,id,schoolId){
 const direct=new Set(['learners','teachers','classes','subjects','academic_years','terms','assessments','grading_systems','teacher_subject_assignments','class_teacher_assignments']);
 if(!id){const e=new Error(`${table} id is required`);e.status=400;throw e;}
 if(table==='school_levels'){const q=await db.query(`SELECT sl.id FROM school_levels sl JOIN school_sections ss ON ss.id=sl.school_section_id WHERE sl.id=$1 AND ss.school_id=$2`,[id,schoolId]);if(!q.rows[0]){const e=new Error('school_levels record does not belong to this school');e.status=403;throw e;}return true;}
 if(!direct.has(table))throw new Error('Unsupported tenant resource');
 const q=await db.query(`SELECT id FROM ${table} WHERE id=$1 AND school_id=$2`,[id,schoolId]);if(!q.rows[0]){const e=new Error(`${table} record does not belong to this school`);e.status=403;throw e;}return true;
}
module.exports={schoolExists,assertBelongs};
