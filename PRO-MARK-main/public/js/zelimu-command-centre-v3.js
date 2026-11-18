
(function(){
'use strict';

function start(){
  const dashboard=document.querySelector('.zelimu-command-v1');
  const sidebar=document.querySelector('.pm-workflow-intro');
  const nav=document.getElementById('navTabs');

  if(!dashboard||!sidebar||!nav)return;

  if(dashboard.dataset.zcV3)return;
  dashboard.dataset.zcV3='true';

  const oldLearners=document.getElementById('zccLearners');
  const oldTeachers=document.getElementById('zccTeachers');

  const readCount=(el)=>{
    if(!el)return null;
    const s=(el.textContent||'').trim();
    const m=s.match(/\d[\d,]*/);
    return m?m[0]:null;
  };

  const initialLearners=readCount(oldLearners);
  const initialTeachers=readCount(oldTeachers);

  const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;',
    '"':'&quot;',"'":'&#39;'
  }[c]));

  const cards=[
    ['🎓','Learners','green','pm24_4','Enrolled learners'],
    ['👩‍🏫','Staff','blue','pm24_3','Registered teachers'],
    ['✓','Attendance','mint','pm24_13','Daily attendance'],
    ['💳','Fee Collection','amber','pm24_28','School finance'],
    ['📝','Assessments','purple','pm24_7','Assessment records'],
    ['⏳','Pending Tasks','red','pm24_17','Review workflows']
  ];

  const kpis=cards.map((c,i)=>`
    <button type="button" class="zc-kpi ${c[2]}" data-zc-target="${c[3]}">
      <span class="zc-kpi-icon">${c[0]}</span>
      <span class="zc-kpi-label">${c[1]}</span>
      <span class="zc-kpi-value" id="zc-value-${i}">${
        i===0?esc(initialLearners||'—'):
        i===1?esc(initialTeachers||'—'):'—'
      }</span>
      <span class="zc-kpi-foot">${c[4]}</span>
    </button>`).join('');

  const empty=(label)=>`
    <div class="zc-empty">
      <span class="zc-empty-icon">▥</span>
      <strong>Live data not available</strong>
      <span>${esc(label)}</span>
    </div>`;

  dashboard.classList.add('zc-dashboard');

  dashboard.innerHTML=`
    <div class="zc-heading">
      <div>
        <h1>School Command Centre</h1>
        <p id="zc-school-context">Live school operations and management insights</p>
      </div>
      <div class="zc-heading-actions">
        <span class="zc-date" id="zc-date"></span>
        <button type="button" class="zc-action" data-zc-target="pm24_4">+ Quick Actions</button>
      </div>
    </div>

    <div class="zc-kpis">${kpis}</div>

    <div class="zc-grid">
      <section class="zc-panel">
        <h2>Academic Performance Trend</h2>
        <p class="zc-panel-sub">Performance across assessment periods</p>
        ${empty('Assessment trend will appear when verified results are available.')}
        <p><button type="button" class="zc-panel-link" data-zc-target="pm24_10">Open academic analytics</button></p>
      </section>

      <section class="zc-panel">
        <h2>Attendance by Class</h2>
        <p class="zc-panel-sub">Daily learner attendance overview</p>
        ${empty('Class attendance requires recorded daily registers.')}
        <p><button type="button" class="zc-panel-link" data-zc-target="pm24_13">Open attendance</button></p>
      </section>

      <section class="zc-panel">
        <h2>Pending Approvals & Actions</h2>
        <p class="zc-panel-sub">Items requiring school attention</p>
        <div class="zc-mini-row"><span>Assessment review</span><span class="zc-status">Open workspace</span></div>
        <div class="zc-mini-row"><span>Examination control</span><span class="zc-status">Open workspace</span></div>
        <div class="zc-mini-row"><span>School finance</span><span class="zc-status">Open workspace</span></div>
        <button type="button" class="zc-panel-link" data-zc-target="pm24_17">Review exam control</button>
      </section>
    </div>

    <div class="zc-grid">
      <section class="zc-panel">
        <h2>Recent School Activity</h2>
        <p class="zc-panel-sub">Latest verified school operations</p>
        ${empty('No activity feed has been connected to this dashboard yet.')}
      </section>

      <section class="zc-panel">
        <h2>Fee Collection Overview</h2>
        <p class="zc-panel-sub">Payments, balances and collection trends</p>
        ${empty('Finance charts require verified payment and billing totals.')}
        <p><button type="button" class="zc-panel-link" data-zc-target="pm24_28">Open school finance</button></p>
      </section>

      <section class="zc-panel">
        <h2>School Calendar & Notices</h2>
        <p class="zc-panel-sub">Upcoming activities and announcements</p>
        ${empty('No calendar events have been loaded.')}
        <p><button type="button" class="zc-panel-link" data-zc-target="announcements">Open announcements</button></p>
      </section>
    </div>

    <section class="zc-panel">
      <h2>Module Shortcuts</h2>
      <p class="zc-panel-sub">Quick access to school operations</p>
      <div class="zc-shortcuts">
        <button class="zc-shortcut" data-zc-target="pm24_4">🎓 Learner Management</button>
        <button class="zc-shortcut" data-zc-target="pm24_8">📝 Assessment Entry</button>
        <button class="zc-shortcut" data-zc-target="pm24_11">📊 Generate Reports</button>
        <button class="zc-shortcut" data-zc-target="pm24_28">💳 Fee Management</button>
        <button class="zc-shortcut" data-zc-target="pm24_12">📅 Timetable Generator</button>
        <button class="zc-shortcut" data-zc-target="pm24_3">👩‍🏫 Staff Management</button>
        <button class="zc-shortcut" data-zc-target="pm24_15">💬 Parent Communication</button>
        <button class="zc-shortcut" data-zc-target="pm24_21">⚙️ School Branding</button>
      </div>
    </section>`;

  const brand=document.createElement('div');
  brand.className='zc-sidebar-home';
  brand.innerHTML=`
    <span class="zc-sidebar-mark">Z</span>
    <span><strong>ZELIMU CBC</strong><small>Smart Schools. Brighter Futures.</small></span>`;

  sidebar.insertBefore(brand,sidebar.firstChild);

  const home=document.createElement('button');
  home.type='button';
  home.className='zc-home-link';
  home.textContent='▦  Command Centre';
  brand.insertAdjacentElement('afterend',home);

  function showHome(){
    dashboard.style.setProperty('display','block','important');
    dashboard.scrollIntoView({behavior:'smooth',block:'start'});
  }

  home.addEventListener('click',showHome);

  dashboard.addEventListener('click',function(e){
    const b=e.target.closest('[data-zc-target]');
    if(!b)return;
    const target=b.dataset.zcTarget;

    if(/^pm24_\d+$/.test(target)){
      const original=nav.querySelector(
        '[data-target="'+target+'"]'
      );
      if(original){
        original.click();
        return;
      }
      if(typeof openPM24==='function'){
        openPM24(Number(target.split('_')[1]));
        return;
      }
    }

    const original=nav.querySelector(
      '[data-target="'+target+'"]'
    );
    if(original){
      original.click();
    }else if(typeof showSection==='function'){
      showSection(target);
    }
  });

  const date=document.getElementById('zc-date');
  if(date){
    date.textContent=new Intl.DateTimeFormat('en-KE',{
      day:'numeric',month:'short',year:'numeric'
    }).format(new Date());
  }

  const context=document.getElementById('zc-school-context');
  const school=document.getElementById('schoolTitle');
  if(context&&school){
    const name=(school.textContent||'').trim();
    if(name)context.textContent='Live school operations • '+name;
  }

  // Reuse the existing application's populated counts.
  // Do not invent learner, staff or other metrics.
  function syncCounts(){
    const targets=[
      ['learnerCount','zc-value-0'],
      ['teacherCount','zc-value-1']
    ];
    targets.forEach(([sourceId,targetId])=>{
      const source=document.getElementById(sourceId);
      const target=document.getElementById(targetId);
      const count=readCount(source);
      if(target&&count!==null)target.textContent=count;
    });
  }

  syncCounts();

  const counterObserver=new MutationObserver(syncCounts);
  ['learnerCount','teacherCount'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)counterObserver.observe(el,{
      childList:true,characterData:true,subtree:true
    });
  });

  // Preserve original module navigation and all delegated handlers.
  // Only update sidebar styling; do not remove or replace nav buttons.
  nav.addEventListener('click',function(e){
    const b=e.target.closest('button[data-target]');
    if(!b)return;
    nav.querySelectorAll('.zc-selected').forEach(
      x=>x.classList.remove('zc-selected')
    );
    b.classList.add('zc-selected');
  });

  console.info('ZELIMU CBC professional Command Centre V3 loaded');
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',start,{once:true});
}else{
  start();
}
})();


/* ZELIMU KPI SYNC BLOCK 3 */
(function(){
  function sync(){
    const pairs = [
      ['learnerCount', 'Learners'],
      ['teacherCount', 'Staff']
    ];

    for(const [sourceId,label] of pairs){
      const source=document.getElementById(sourceId);
      if(!source)continue;

      const value=source.textContent.trim();
      if(!value || value==='—')continue;

      document.querySelectorAll('.zc-kpi').forEach(card=>{
        const text=card.textContent||'';
        if(!text.includes(label))return;

        const target=card.querySelector('strong');
        if(target && target.textContent.trim()!==value){
          target.textContent=value;
        }
      });
    }
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',sync,{once:true});
  }else{
    sync();
  }

  const observer=new MutationObserver(sync);

  window.addEventListener('load',function(){
    ['learnerCount','teacherCount'].forEach(id=>{
      const node=document.getElementById(id);
      if(node){
        observer.observe(node,{
          childList:true,
          characterData:true,
          subtree:true
        });
      }
    });
    sync();
  },{once:true});
})();
