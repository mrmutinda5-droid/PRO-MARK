const jwt=require("jsonwebtoken");
const crypto=require("crypto");
const db=require("../db");
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEACHING_ROLES=new Set(["TEACHER","CLASS_TEACHER","SENIOR_TEACHER"]);

// A token is only a claim. Every request re-reads the account so that
// deactivation, role changes, staff deactivation and password resets take
// effect immediately instead of waiting for the 8-hour token to expire.
async function authenticate(req,res,next){
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):null;
  if(!token)return res.status(401).json({error:"Authentication required"});
  let claims;
  try{claims=jwt.verify(token,process.env.JWT_SECRET);}
  catch{return res.status(401).json({error:"Invalid or expired token"});}
  if(!UUID_RE.test(String(claims.user_id||"")))return res.status(401).json({error:"Invalid or expired token"});
  try{
    const u=(await db.query(`SELECT to_jsonb(u)->>'is_active' AS is_active,COALESCE(to_jsonb(u)->>'password_hash','') AS password_hash FROM users u WHERE u.id=$1`,[claims.user_id])).rows[0];
    if(!u||String(u.is_active).toLowerCase()==="false")return res.status(401).json({error:"This account is inactive. Please sign in again."});
    if(claims.pv){
      const current=crypto.createHash("sha256").update(String(u.password_hash||"")).digest("hex").slice(0,16);
      if(current!==claims.pv)return res.status(401).json({error:"Your password was changed. Please sign in again."});
    }
    const claimSchool=UUID_RE.test(String(claims.school_id||""))?String(claims.school_id):null;
    const user={...claims,school_id:claimSchool};
    if(String(claims.role||"").toUpperCase()!=="PLATFORM_OWNER"){
      let roleRow=null;
      try{
        roleRow=(await db.query(
          `SELECT role,school_id FROM user_school_roles
           WHERE user_id=$1 AND ($2::uuid IS NULL OR school_id=$2::uuid)
           ORDER BY (role::text=$3) DESC LIMIT 1`,
          [claims.user_id,claimSchool,String(claims.role||"").toUpperCase()]
        )).rows[0];
      }catch(e){if(e.code!=="42703"&&e.code!=="42P01")throw e;}
      if(roleRow){
        user.role=String(roleRow.role).toUpperCase();
        user.school_id=roleRow.school_id||claimSchool;
      }else{
        // Legacy installations may link teachers through teachers.user_id only.
        let legacy=null;
        try{
          legacy=(await db.query(
            `SELECT t.school_id FROM teachers t
             WHERE t.user_id=$1 AND ($2::uuid IS NULL OR t.school_id=$2::uuid)
             LIMIT 1`,
            [claims.user_id,claimSchool]
          )).rows[0];
        }catch(e){if(e.code!=="42703"&&e.code!=="42P01")throw e;}
        if(!legacy)return res.status(401).json({error:"Your ZELIMU CBC role is no longer active. Please sign in again."});
        user.role="TEACHER";
        user.school_id=legacy.school_id;
      }
    }
    // Staff deactivation is recorded on the teacher profile, not on the login.
    if(TEACHING_ROLES.has(user.role)&&user.school_id){
      try{
        const t=(await db.query(`SELECT COALESCE(bool_or((to_jsonb(t)->>'is_active')::boolean),true) AS active FROM teachers t WHERE t.user_id=$1 AND t.school_id=$2`,[claims.user_id,user.school_id])).rows[0];
        if(t&&t.active===false)return res.status(401).json({error:"Your staff account has been deactivated. Contact your school administrator."});
      }catch(e){if(e.code!=="42703"&&e.code!=="42P01")throw e;}
    }
    req.user=user;
    next();
  }catch(e){
    console.error("Authentication check failed:",e);
    return res.status(503).json({error:"Unable to verify your account right now. Please try again."});
  }
}
function roles(...allowed){return (req,res,next)=>(req.user?.role==='PLATFORM_OWNER'||allowed.includes(req.user?.role))?next():res.status(403).json({error:"Insufficient permission"});}
async function schoolBoundary(req,res,next){
  const sid=req.params.schoolId||req.body?.school_id||req.query?.school_id;
  if(req.user?.role==='PLATFORM_OWNER')return next();
  if(!sid||!req.user?.school_id||sid!==req.user.school_id)return res.status(403).json({error:"School access denied"});
  try{
    const q=await db.query('SELECT status FROM schools WHERE id=$1',[sid]);
    if(!q.rows[0])return res.status(404).json({error:"School not found"});
    if(q.rows[0].status!=='ACTIVE')return res.status(403).json({error:`School is ${String(q.rows[0].status).toLowerCase()}`});
    next();
  }catch(e){console.error(e);res.status(500).json({error:"Unable to verify school access"});}
}
module.exports={authenticate,roles,schoolBoundary};
