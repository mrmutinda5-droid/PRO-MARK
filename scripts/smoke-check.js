const fs=require('fs'),path=require('path'),child=require('child_process');
const root=path.join(__dirname,'..');
const required=['backend/server.js','backend/routes/auth.js','backend/routes/platform.js','backend/routes/school.js','backend/routes/settings.js','backend/routes/people.js','backend/routes/assessments.js','backend/routes/grading.js','backend/routes/merit.js','backend/routes/reports.js','backend/services/report-engine.js','backend/services/report-pdf.js','database/schema.sql','database/001_hardening.sql','database/035_report_pathway_guidance.sql','public/index.html','public/login.html','public/owner.html','public/dashboard.html','public/report-pathway-guidance.js'];
for(const f of required)if(!fs.existsSync(path.join(root,f)))throw Error('Missing '+f);
const jsFiles=[];function walk(d){for(const n of fs.readdirSync(d)){const p=path.join(d,n),st=fs.statSync(p);if(st.isDirectory()&&!['node_modules','.git'].includes(n))walk(p);else if(/\.js$/.test(n))jsFiles.push(p);}}walk(root);for(const f of jsFiles){const r=child.spawnSync(process.execPath,['--check',f],{encoding:'utf8'});if(r.status)throw Error(`Syntax error in ${path.relative(root,f)}\n${r.stderr}`);}
const dash=fs.readFileSync(path.join(root,'public/dashboard.html'),'utf8');if(!dash.includes('Create year + Term 1–3'))throw Error('Academic year control missing');if(!dash.includes('id="teacherMarking"')||!dash.includes('id="markYear"')||!dash.includes('id="markTerm"')||!dash.includes('id="markAssessment"')||!dash.includes('id="markClass"')||!dash.includes('id="markSubject"'))throw Error('Teacher mark-entry controls missing');if(!dash.includes('id="userControl"')||!dash.includes('id="markControl"')||!dash.includes('id="assign"')||!dash.includes('id="classLists"'))throw Error('Administrator navigation controls missing');if(!dash.includes('peopleOpenAssignments')||!dash.includes('peopleOpenClassLists'))throw Error('People quick navigation controls missing.');
if(/section id="workflow" class="[^"]*nav-managed-section/.test(dash))throw Error('The #workflow shortcuts panel is a nav-managed-section again, which means it is permanently hidden (nothing ever calls showSection("workflow")).');
const schemaCompat=fs.readFileSync(path.join(root,'backend/schema-compat.js'),'utf8');
if(!schemaCompat.includes("process.env.ZELIMU_ENABLE_TERM3_IMPORT_REPAIR === 'true'"))throw Error('Term 3 imported-mark repair must remain explicitly opt-in; do not run its UPDATE/DELETE automatically on server startup.');
const repairGuard=schemaCompat.indexOf("if (process.env.ZELIMU_ENABLE_TERM3_IMPORT_REPAIR === 'true')");
const repairUpdate=schemaCompat.indexOf("UPDATE marks m SET assessment_id=c.opener_id");
const repairDelete=schemaCompat.indexOf("DELETE FROM marks m USING assessments a,terms t");
const repairGuardEnd=schemaCompat.indexOf("\n  }",repairGuard);
if(repairGuard<0||repairUpdate<repairGuard||repairDelete<repairGuard||repairGuardEnd<repairDelete)throw Error('Term 3 imported-mark UPDATE/DELETE must remain inside the explicit opt-in guard.');
if(!schemaCompat.includes("process.env.ZELIMU_ENABLE_ROLE_DEDUP_REPAIR === 'true'"))throw Error('Duplicate user-role cleanup must remain explicitly opt-in.');
if(!schemaCompat.includes("process.env.ZELIMU_ENABLE_LEGACY_ADMISSION_CLEANUP === 'true'"))throw Error('Legacy admission-number cleanup must remain explicitly opt-in.');
if(/await db\.query\(`WITH ranked AS[\s\S]*?DELETE FROM user_school_roles/.test(schemaCompat) && !schemaCompat.includes("if (process.env.ZELIMU_ENABLE_ROLE_DEDUP_REPAIR === 'true')"))throw Error('User-role DELETE statements must remain behind the explicit opt-in guard.');
const merit=fs.readFileSync(path.join(root,'backend/routes/merit.js'),'utf8');
if(merit.includes('Intentional cover page'))throw Error('Merit PDF has reintroduced the near-empty cover page.');
const engine=fs.readFileSync(path.join(root,'backend/services/report-engine.js'),'utf8');if(!engine.includes("comment:sm.map(x=>String(x.remark||'').trim()).find(Boolean)||''"))throw Error('Recorded-only subject comment handling missing');if(engine.includes('function autoSubjectComment'))throw Error('Generated subject comments must not replace missing teacher remarks.');console.log(`ZELIMU CBC smoke check passed: ${jsFiles.length} JavaScript files checked.`);
// Navigation integrity: every static module target must resolve to a workspace.
const targets=[...dash.matchAll(/<button\s+data-target="([^"]+)"/g)].map(x=>x[1]);
const ids=new Set([...dash.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));
for(const target of targets){
 if(/^pm24_\d+$/.test(target)){
  if(!dash.includes(`${Number(target.slice(5))}:`) && !dash.includes(`${Number(target.slice(5))}:[`))throw Error('Missing module mapping '+target);
 }else if(!ids.has(target))throw Error('Missing navigation target '+target);
}
if(!ids.has('zelimuModuleSearch')||!ids.has('zelimuClearSearch'))throw Error('Module discovery controls missing');
if(!ids.has('parents')||!ids.has('documents')||!ids.has('announcements'))throw Error('Separated parent, official assets, and announcement workspaces missing');
console.log(`Navigation integrity passed: ${targets.length} menu targets checked.`);
