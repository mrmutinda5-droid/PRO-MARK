
(function(){
  'use strict';

  function cleanSidebar(){
    const sidebar=document.querySelector('.pm-workflow-intro');
    if(!sidebar)return;

    sidebar.classList.add('zc-sidebar-clean');

    sidebar.querySelectorAll('#navTabs .pm-module-group').forEach(group=>{
      const heading=group.querySelector('h3');
      if(!heading)return;

      heading.style.removeProperty('background');
      heading.style.removeProperty('background-color');
      heading.style.removeProperty('background-image');
      heading.style.removeProperty('box-shadow');
      heading.style.removeProperty('border-color');

      heading.classList.add('zc-clean-heading');

      // Preserve existing accordion click handlers.
      // Do not replace headings or navigation buttons.
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',cleanSidebar);
  }else{
    cleanSidebar();
  }
})();
