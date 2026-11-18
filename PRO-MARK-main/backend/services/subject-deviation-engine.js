'use strict';

function calculateDeviation(learners, previousMarks, currentMarks) {
  const previous = new Map();
  const current = new Map();

  for (const mark of previousMarks) {
    const id = String(mark.learner_id);
    if (mark.percent !== null && mark.percent !== undefined && mark.percent !== '' && Number.isFinite(Number(mark.percent))) {
      previous.set(id, Number(mark.percent));
    }
  }

  for (const mark of currentMarks) {
    const id = String(mark.learner_id);
    if (mark.percent !== null && mark.percent !== undefined && mark.percent !== '' && Number.isFinite(Number(mark.percent))) {
      current.set(id, Number(mark.percent));
    }
  }

  const rows = learners.map(learner => {
    const id = String(learner.id);
    const before = previous.has(id) ? previous.get(id) : null;
    const after = current.has(id) ? current.get(id) : null;

    return {
      learner_id: id,
      admission_no: learner.admission_no,
      learner_name: [learner.first_name, learner.last_name]
        .filter(Boolean).join(' '),
      previous: before,
      current: after,
      deviation: before === null || after === null
        ? null
        : Number((after - before).toFixed(2))
    };
  });

  const comparable = rows.filter(r => r.deviation !== null);
  const mean = values => values.length
    ? values.reduce((a,b) => a+b, 0) / values.length
    : null;

  return {
    rows,
    summary: {
      learners: rows.length,
      compared: comparable.length,
      improved: comparable.filter(r => r.deviation > 0).length,
      declined: comparable.filter(r => r.deviation < 0).length,
      unchanged: comparable.filter(r => r.deviation === 0).length,
      previous_mean: mean(comparable.map(r => r.previous)),
      current_mean: mean(comparable.map(r => r.current)),
      mean_deviation: mean(comparable.map(r => r.deviation))
    }
  };
}

module.exports = { calculateDeviation };
