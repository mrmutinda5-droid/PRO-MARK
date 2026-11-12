require("dotenv").config();
const bcrypt=require("bcryptjs"),db=require("../backend/db");
(async()=>{
 const email=String(process.env.PLATFORM_OWNER_EMAIL||"").trim().toLowerCase(),pw=String(process.env.PLATFORM_OWNER_PASSWORD||"");
 if(!email||pw.length<10) throw Error("Set PLATFORM_OWNER_EMAIL and a password of at least 10 characters");
 const hash=await bcrypt.hash(pw,12);
 const u=(await db.query(`INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,$2,'Platform','Owner')
 ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,is_active=true,updated_at=now() RETURNING id`,[email,hash])).rows[0];
 await db.query(`DELETE FROM user_school_roles WHERE user_id=$1 AND role<>'PLATFORM_OWNER'`,[u.id]);
 await db.query(`INSERT INTO user_school_roles(user_id,school_id,role,mark_entry_enabled) VALUES($1,NULL,'PLATFORM_OWNER',true) ON CONFLICT DO NOTHING`,[u.id]);
 console.log(`Platform owner ready: ${email}`); await db.pool.end();
})().catch(async e=>{console.error(e);await db.pool.end();process.exit(1);});
