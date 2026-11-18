const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const crypto=require('crypto');
const db=require('../db');
const router=express.Router();
const {authenticate}=require('../middleware/auth');

async function tableColumns(table){
  const q=await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
  return new Set(q.rows.map(r=>r.column_name));
}

// Password fingerprint carried inside the token. When the stored hash changes
// (self-service change, administrator reset, recovery email) every older token
// is rejected immediately by the authenticate middleware.
function passwordFingerprint(hash){
  return crypto.createHash('sha256').update(String(hash||'')).digest('hex').slice(0,16);
}

// Brute-force protection. Failures are tracked per email+IP so a school cannot
// be locked out by an attacker working from a different network.
const LOGIN_MAX_FAILURES=10;
const LOGIN_WINDOW_MS=15*60*1000;
const LOGIN_LOCK_MS=15*60*1000;
const loginFailures=new Map();
function loginKey(req,email){
  const ip=String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.ip||'unknown';
  return `${ip}|${email}`;
}
function loginLockMinutes(key){
  const r=loginFailures.get(key);
  if(!r)return 0;
  const now=Date.now();
  if(r.blockedUntil&&r.blockedUntil>now)return Math.ceil((r.blockedUntil-now)/60000);
  if(now-r.first>LOGIN_WINDOW_MS)loginFailures.delete(key);
  return 0;
}
function recordLoginFailure(key){
  const now=Date.now();
  let r=loginFailures.get(key);
  if(!r||now-r.first>LOGIN_WINDOW_MS){r={count:0,first:now,blockedUntil:0};loginFailures.set(key,r);}
  r.count+=1;
  if(r.count>=LOGIN_MAX_FAILURES)r.blockedUntil=now+LOGIN_LOCK_MS;
  if(loginFailures.size>20000){
    for(const [k,v] of loginFailures)if(now-v.first>LOGIN_WINDOW_MS)loginFailures.delete(k);
  }
}

// Recovery-email abuse protection: five requests per address per 15 minutes.
const resetRequests=new Map();
const RESET_WINDOW_MS=15*60*1000;
const RESET_MAX=5;
function resetRequestBlocked(email){
  const now=Date.now(),r=resetRequests.get(email);
  if(!r){resetRequests.set(email,{count:1,first:now});return false;}
  if(now-r.first>RESET_WINDOW_MS){resetRequests.set(email,{count:1,first:now});return false;}
  r.count+=1;
  return r.count>RESET_MAX;
}

router.post('/login',async(req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    const requestedRole=String(req.body.role||'').trim().toUpperCase();
    const requestedSchoolId=String(req.body.school_id||'').trim();
    if(!email||!password)return res.status(400).json({error:'Email and password are required'});
    const failKey=loginKey(req,email);
    const lockedFor=loginLockMinutes(failKey);
    if(lockedFor)return res.status(429).json({error:`Too many failed sign-in attempts for this account from this device. Try again in ${lockedFor} minute${lockedFor===1?'':'s'}.`});

    // IMPORTANT: existing ZELIMU CBC installations are not all on the same schema.
    // Login must therefore discover optional columns/tables instead of assuming
    // the newest schema. This prevents a database-column mismatch from becoming
    // a generic HTTP 500 during login.
    const usersCols=await tableColumns('users');
    if(!usersCols.has('email')||!usersCols.has('password_hash')){
      return res.status(500).json({error:'The users table is missing the required email/password columns.'});
    }

    const uq=await db.query(`SELECT id,email,password_hash,${usersCols.has('first_name')?'first_name':'NULL::text AS first_name'},${usersCols.has('last_name')?'last_name':'NULL::text AS last_name'},${usersCols.has('is_active')?'is_active':'true AS is_active'} FROM users WHERE LOWER(email)=$1 LIMIT 1`,[email]);
    if(!uq.rows.length){recordLoginFailure(failKey);return res.status(401).json({error:'Invalid email or password'});}
    const base=uq.rows[0];
    if(base.is_active===false)return res.status(403).json({error:'This account is inactive.'});
    if(!base.password_hash || !(await bcrypt.compare(password,base.password_hash))){recordLoginFailure(failKey);return res.status(401).json({error:'Invalid email or password'});}

    const roleRows=[];
    const roleCols=await tableColumns('user_school_roles');
    if(roleCols.size){
      const hasSchool=roleCols.has('school_id');
      const hasMark=roleCols.has('mark_entry_enabled');
      const hasCreated=roleCols.has('created_at');
      const rq=await db.query(`SELECT id,user_id,${hasSchool?'school_id':'NULL::uuid AS school_id'},role,${hasMark?'mark_entry_enabled':'true AS mark_entry_enabled'},${hasCreated?'created_at':'NULL::timestamptz AS created_at'} FROM user_school_roles WHERE user_id=$1`,[base.id]);
      roleRows.push(...rq.rows.map(r=>({role:String(r.role).toUpperCase(),school_id:r.school_id||null,mark_entry_enabled:r.mark_entry_enabled!==false,created_at:r.created_at,id:r.id})));
    }

    // Older installations may have teacher accounts linked through teachers.user_id
    // before a user_school_roles row was created. Use that link as a safe fallback.
    const teacherCols=await tableColumns('teachers');
    if(teacherCols.has('user_id')&&teacherCols.has('school_id')){
      const tq=await db.query(`SELECT id,school_id FROM teachers WHERE user_id=$1 ${teacherCols.has('is_active')?'AND is_active=true':''} LIMIT 50`,[base.id]);
      for(const t of tq.rows){
        if(!roleRows.some(r=>String(r.school_id||'')===String(t.school_id||''))){
          roleRows.push({role:'TEACHER',school_id:t.school_id||null,mark_entry_enabled:true,created_at:null,id:`teacher:${t.id}`});
        }
      }
    }

    if(!roleRows.length)return res.status(403).json({error:'This account is not assigned a ZELIMU CBC role. Ask an administrator to assign a role.'});

    let candidates=roleRows;
    if(requestedRole)candidates=candidates.filter(r=>r.role===requestedRole);
    if(requestedSchoolId)candidates=candidates.filter(r=>String(r.school_id||'')===requestedSchoolId);
    if(!candidates.length)return res.status(403).json({error:'The selected role or school is not assigned to this account.'});

    // Build school metadata only after the role has been identified. Support both
    // the current schools(name/status) schema and older school_name/active schemas.
    const schoolCols=await tableColumns('schools');
    const schoolMap=new Map();
    const schoolIds=[...new Set(candidates.map(r=>r.school_id).filter(Boolean))];
    if(schoolIds.length&&schoolCols.has('id')){
      const nameExpr=schoolCols.has('name')?'name':(schoolCols.has('school_name')?'school_name':"''");
      const statusExpr=schoolCols.has('status')?'status':(schoolCols.has('active')?`CASE WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END`:"'ACTIVE'");
      const sq=await db.query(`SELECT id,${nameExpr} AS school_name,${statusExpr} AS school_status FROM schools WHERE id = ANY($1::uuid[])`,[schoolIds]);
      sq.rows.forEach(s=>schoolMap.set(String(s.id),s));
    }

    const enriched=candidates.map(r=>{const s=schoolMap.get(String(r.school_id||''));return {...r,school_name:s?.school_name||null,school_status:String(s?.school_status||'ACTIVE').toUpperCase()};});
    const unique=[...new Map(enriched.map(x=>[`${x.role}::${x.school_id||''}`,x])).values()];

    if(unique.length>1&&!requestedRole){
      return res.status(409).json({error:'This email has more than one ZELIMU CBC role. Select the intended role and school.',roles:unique.map(x=>({role:x.role,school_id:x.school_id,school_name:x.school_name}))});
    }
    if(unique.length>1&&requestedRole&&!requestedSchoolId){
      const sameRole=unique.filter(x=>x.role===requestedRole);
      if(sameRole.length>1)return res.status(409).json({error:'This role is assigned to more than one school. Select the intended school.',roles:sameRole.map(x=>({role:x.role,school_id:x.school_id,school_name:x.school_name}))});
    }

    // If a role was requested, use that exact candidate; otherwise use the first.
    const chosen=unique.find(x=>(!requestedRole||x.role===requestedRole)&&(!requestedSchoolId||String(x.school_id||'')===requestedSchoolId))||unique[0];
    if(chosen.school_id&&chosen.school_status!=='ACTIVE')return res.status(403).json({error:`School is ${String(chosen.school_status).toLowerCase()}`});

    const user={
      id:base.id,email:base.email,first_name:base.first_name||'',last_name:base.last_name||'',
      role:chosen.role,school_id:chosen.school_id||null,school_name:chosen.school_name||null,
      mark_entry_enabled:chosen.mark_entry_enabled!==false
    };
    loginFailures.delete(failKey);
    const token=jwt.sign({user_id:base.id,email:base.email,role:chosen.role,school_id:chosen.school_id||null,pv:passwordFingerprint(base.password_hash)},process.env.JWT_SECRET,{expiresIn:'8h'});
    return res.json({token,user});
  }catch(e){
    console.error('LOGIN ERROR:',e && e.stack ? e.stack : e);
    return res.status(500).json({error:'Login failed. Check the server console for the exact database error.'});
  }
});


// Password recovery uses one-time, hashed tokens. Configure RESEND_API_KEY,
// PASSWORD_RESET_FROM (verified sender), and APP_BASE_URL in the hosting environment.
async function sendResetEmail(to, link){
  const key=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.PASSWORD_RESET_FROM||'').trim();
  if(!key||!from) return false;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to,subject:'Reset your ZELIMU CBC password',html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#18212b"><h2 style="color:#17365d">ZELIMU CBC</h2><h3>Password reset request</h3><p>We received a request to reset the password for your account.</p><p><a href="${link}" style="display:inline-block;background:#17365d;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Reset password</a></p><p>This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p></div>`})});
  if(!response.ok){const body=await response.text().catch(()=> '');console.error('PASSWORD RESET EMAIL ERROR:',response.status,body.slice(0,300));return false;}return true;
}
router.post('/forgot-password',async(req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    // Generic response prevents account enumeration.
    const generic={ok:true,message:'If an account exists for that email, password-reset instructions will be sent.'};
    if(!email||email.length>254||!/^\S+@\S+\.\S+$/.test(email))return res.json(generic);
    if(resetRequestBlocked(email))return res.status(429).json({error:'Too many password-reset requests for this email. Please try again in 15 minutes.'});
    const configured=Boolean(process.env.RESEND_API_KEY&&process.env.PASSWORD_RESET_FROM&&process.env.APP_BASE_URL);
    if(!configured)return res.status(503).json({error:'Self-service password reset is not configured yet. Please contact your school administrator.'});
    const uq=await db.query('SELECT id,email FROM users WHERE LOWER(email)=$1 LIMIT 1',[email]);
    if(!uq.rows.length)return res.json(generic);
    await db.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
    await db.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[uq.rows[0].id]);
    const token=crypto.randomBytes(32).toString('hex');
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    await db.query('INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'30 minutes\')',[uq.rows[0].id,tokenHash]);
    const base=String(process.env.APP_BASE_URL).replace(/\/$/,'');
    const sent=await sendResetEmail(uq.rows[0].email,`${base}/reset-password.html?token=${token}`);
    if(!sent)return res.status(503).json({error:'We could not send the reset email. Please contact your school administrator.'});
    return res.json(generic);
  }catch(e){console.error('FORGOT PASSWORD ERROR:',e);return res.status(500).json({error:'Unable to process the reset request right now.'});}
});
router.post('/reset-password',async(req,res)=>{
  try{
    const token=String(req.body?.token||'').trim();const password=String(req.body?.new_password||'');
    if(!token||token.length>200)return res.status(400).json({error:'Reset link is invalid or expired.'});
    if(password.length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});
    await db.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (id bigserial PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const q=await db.query('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() LIMIT 1',[tokenHash]);
    if(!q.rows.length)return res.status(400).json({error:'Reset link is invalid or expired. Please request a new one.'});
    const hash=await bcrypt.hash(password,12);
    await db.query('BEGIN');
    try{await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1',[q.rows[0].user_id,hash]);await db.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1',[q.rows[0].id]);await db.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[q.rows[0].user_id]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
    return res.json({ok:true,message:'Password reset successfully. You can now sign in.'});
  }catch(e){console.error('RESET PASSWORD ERROR:',e);return res.status(500).json({error:'Unable to reset the password right now.'});}
});

// Authenticated self-service password change. Existing password hashes are never exposed.
router.post('/change-password',authenticate,async(req,res)=>{
  try{
    const current=String(req.body?.current_password||'');
    const next=String(req.body?.new_password||'');
    if(next.length<10)return res.status(400).json({error:'New password must be at least 10 characters.'});
    const q=await db.query('SELECT password_hash FROM users WHERE id=$1',[req.user.user_id]);
    if(!q.rows[0])return res.status(404).json({error:'User account not found.'});
    if(!current || !(await bcrypt.compare(current,q.rows[0].password_hash)))return res.status(401).json({error:'Current password is incorrect.'});
    const hash=await bcrypt.hash(next,12);
    await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1',[req.user.user_id,hash]);
    // Every other session is invalidated by the password fingerprint. Issue a
    // fresh token so the person who made the change stays signed in.
    const token=jwt.sign({user_id:req.user.user_id,email:req.user.email,role:req.user.role,school_id:req.user.school_id||null,pv:passwordFingerprint(hash)},process.env.JWT_SECRET,{expiresIn:'8h'});
    res.json({ok:true,token,message:'Password changed successfully. All other sessions have been signed out.'});
  }catch(e){console.error('CHANGE PASSWORD ERROR:',e);res.status(500).json({error:'Unable to change password.'});}
});

module.exports=router;
