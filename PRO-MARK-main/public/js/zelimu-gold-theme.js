/* ZELIMU CBC — GOLD COMMAND CENTRE ENHANCEMENTS
   Adds the greeting, KPI sparklines and report-card showcase to the existing
   z7 dashboard. It only decorates the rendered dashboard; navigation, refresh,
   data loading and every existing handler stay untouched. */
(function () {
  'use strict';

  var sparkPaths = [
    'M0 31 L16 28 L32 30 L48 22 L64 24 L80 15 L96 18 L112 9 L120 7',
    'M0 26 L16 29 L32 23 L48 25 L64 18 L80 21 L96 12 L112 14 L120 8',
    'M0 30 L16 25 L32 27 L48 19 L64 23 L80 16 L96 20 L112 11 L120 13',
    'M0 28 L16 30 L32 24 L48 21 L64 26 L80 17 L96 14 L112 19 L120 10',
    'M0 32 L16 27 L32 29 L48 24 L64 20 L80 23 L96 15 L112 17 L120 9',
    'M0 25 L16 28 L32 22 L48 26 L64 19 L80 22 L96 16 L112 12 L120 15'
  ];

  var reportBanner =
    '<section class="z7-report-banner" aria-label="Report card studio">' +
      '<div class="z7-report-copy">' +
        '<span class="z7-kicker">Report Card Studio</span>' +
        '<h2>Every exam. Every CAT. One clear report.</h2>' +
        '<p>Term report cards now read every assessment captured for the term — Opener, CATs, Mid Term and End Term — and calculate the average from your saved term merit settings.</p>' +
        '<div class="z7-report-actions">' +
          '<button type="button" class="z7-gold-btn" data-z7-target="pm24_11">Open Report Cards</button>' +
          '<button type="button" class="z7-ghost-btn" data-z7-target="pm24_12">Merit &amp; Rankings</button>' +
        '</div>' +
        '<div class="z7-report-points">' +
          '<span><b>✓</b> All exams &amp; CATs printed</span>' +
          '<span><b>✓</b> Merit weights applied</span>' +
          '<span><b>✓</b> Ranks match averages</span>' +
        '</div>' +
      '</div>' +
      '<div class="z7-paper" aria-hidden="true">' +
        '<div class="z7-paper-head">' +
          '<span class="z7-paper-crest">✦</span>' +
          '<div><b>ZELIMU CBC</b><small>Competence Based Curriculum</small></div>' +
        '</div>' +
        '<div class="z7-paper-title">LEARNER REPORT CARD</div>' +
        '<div class="z7-paper-meta"><span>Name</span><span>Class</span><span>Term</span></div>' +
        '<div class="z7-paper-table">' +
          '<div class="z7-paper-row z7-paper-headrow"><span>Learning Area</span><span>CAT 1</span><span>CAT 2</span><span>End Term</span><span>Grade</span></div>' +
          '<div class="z7-paper-row"><span>Mathematics</span><span>—</span><span>—</span><span>—</span><span>—</span></div>' +
          '<div class="z7-paper-row"><span>English</span><span>—</span><span>—</span><span>—</span><span>—</span></div>' +
          '<div class="z7-paper-row"><span>Kiswahili</span><span>—</span><span>—</span><span>—</span><span>—</span></div>' +
          '<div class="z7-paper-row"><span>Integrated Science</span><span>—</span><span>—</span><span>—</span><span>—</span></div>' +
          '<div class="z7-paper-row"><span>Social Studies</span><span>—</span><span>—</span><span>—</span><span>—</span></div>' +
        '</div>' +
        '<span class="z7-paper-seal">Z</span>' +
        '<div class="z7-paper-foot">Discipline today · Greater tomorrow</div>' +
      '</div>' +
    '</section>';

  function readUser() {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}') || {};
    } catch (error) {
      return {};
    }
  }

  function firstName() {
    var user = readUser();
    var name = [user.first_name, user.middle_name, user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || user.name || user.email || '';
    if (!name) {
      var shown = (document.getElementById('z7User') || {}).textContent || '';
      shown = shown.trim();
      if (shown && !/signed-in user/i.test(shown)) name = shown.split('·')[0].trim();
    }
    return name ? name.split(/\s+/)[0] : '';
  }

  function greeting() {
    var hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function decorateHeading(root) {
    var heading = root.querySelector('.z7-heading');
    if (!heading) return;
    var left = heading.firstElementChild;
    if (!left) return;

    if (!heading.querySelector('.z7-eyebrow')) {
      var eyebrow = document.createElement('span');
      eyebrow.className = 'z7-eyebrow';
      eyebrow.innerHTML = '<i></i> School Command Centre';
      left.insertBefore(eyebrow, left.firstChild);
    }

    var title = left.querySelector('h1');
    if (title) {
      var name = firstName();
      var key = greeting() + '|' + name;
      if (title.getAttribute('data-zg-title') !== key) {
        title.innerHTML = escapeHtml(greeting()) + (name ? ', <em>' + escapeHtml(name) + '</em>' : '');
        title.setAttribute('data-zg-title', key);
      }
    }

    var right = heading.querySelector('.z7-heading-right');
    if (right) {
      var term = right.querySelector('.z7-hero-term');
      if (!term) {
        term = document.createElement('div');
        term.className = 'z7-hero-term';
        term.innerHTML = '<span>Academic period</span><b></b>';
        right.insertBefore(term, right.firstChild);
      }
      var yearSelect = document.getElementById('z7YearSelect');
      var termSelect = document.getElementById('z7TermSelect');
      var year = yearSelect && yearSelect.selectedOptions[0] ? yearSelect.selectedOptions[0].textContent.trim() : '';
      var period = termSelect && termSelect.selectedOptions[0] ? termSelect.selectedOptions[0].textContent.trim() : '';
      if (/academic year|current term/i.test(year + ' ' + period)) {
        year = '';
        period = '';
      }
      var label = [year, period].filter(Boolean).join(' · ') || 'Current academic period';
      var target = term.querySelector('b');
      if (target && target.textContent !== label) target.textContent = label;
    }
  }

  function decorateKpis(root) {
    var cards = root.querySelectorAll('.z7-kpi');
    for (var index = 0; index < cards.length; index += 1) {
      var card = cards[index];
      if (card.querySelector('.z7-spark')) continue;
      var spark = document.createElement('span');
      spark.className = 'z7-spark';
      spark.setAttribute('aria-hidden', 'true');
      spark.innerHTML = '<svg viewBox="0 0 120 40" preserveAspectRatio="none"><path d="' +
        sparkPaths[index % sparkPaths.length] + '"/></svg>';
      card.appendChild(spark);
    }
  }

  function addReportBanner(root) {
    if (root.querySelector('.z7-report-banner')) return;
    var kpis = root.querySelector('.z7-kpis');
    if (kpis) kpis.insertAdjacentHTML('afterend', reportBanner);
  }

  function decorate() {
    var root = document.querySelector('.z7');
    if (!root) return;
    document.body.classList.add('zg-gold');
    decorateHeading(root);
    decorateKpis(root);
    addReportBanner(root);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(function () {
      scheduled = false;
      decorate();
    }, 140);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      decorate();
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }, { once: true });
  } else {
    decorate();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('load', schedule, { once: true });
})();
