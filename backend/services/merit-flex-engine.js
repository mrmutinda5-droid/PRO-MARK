'use strict';

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function subjectResult(marks, ids, mode, catIds, weights = {}) {
  const byId = new Map();

  for (const mark of marks || []) {
    const id = String(mark.assessment_id);
    if (!ids.includes(id)) continue;

    if (byId.has(id)) {
      return { complete: false, score: null, reason: 'DUPLICATE_MARK' };
    }

    if (mark.percent != null && Number.isFinite(Number(mark.percent))) {
      byId.set(id, Number(mark.percent));
    }
  }

  const missing = ids.filter(id => !byId.has(id));

  if (missing.length) {
    return {
      complete: false,
      score: null,
      reason: 'MISSING_MARKS',
      missing
    };
  }

  if (!ids.length) {
    return {
      complete: false,
      score: null,
      reason: 'NO_ASSESSMENTS'
    };
  }

  if (mode === 'CUSTOM') {
    const total = ids.reduce(
      (sum, id) => sum + Number(weights[id] || 0), 0
    );

    if (Math.abs(total - 100) > 0.02) {
      return {
      complete:false,
      score:null,
      reason:'INVALID_WEIGHTS',
      weight_total:total
    };
    }

    return {
      complete: true,
      score: ids.reduce(
        (sum, id) => sum + byId.get(id) * Number(weights[id] || 0) / 100,
        0
      ),
      reason: null
    };
  }

  const main = ids
    .filter(id => !catIds.includes(id))
    .map(id => byId.get(id));

  const cats = ids
    .filter(id => catIds.includes(id))
    .map(id => byId.get(id));

  const parts = mode === 'CAT_GROUP'
    ? [...main, ...(cats.length ? [average(cats)] : [])]
    : [...main, ...cats];

  return {
    complete: true,
    score: average(parts),
    reason: null
  };
}

function calculate(
  learners,
  subjectIds,
  selected,
  mode,
  catIds,
  weights = {},
  assessmentSubjects = {}
) {
  const ids = selected.map(String);
  const cats = catIds.map(String);
  const output = [];

  for (const learner of learners) {
    const subjects = subjectIds.map(subjectId => {
      const applicableIds = ids.filter(id => {
        const assignedSubject = assessmentSubjects[id];
        return !assignedSubject ||
          String(assignedSubject) === String(subjectId);
      });

      const applicableCats = cats.filter(id =>
        applicableIds.includes(id)
      );

      const subjectMarks = (learner.marks || []).filter(
        mark => String(mark.subject_id) === String(subjectId)
      );

      const result = subjectResult(
        subjectMarks,
        applicableIds,
        mode,
        applicableCats,
        weights
      );

      return {
        subject_id: subjectId,
        ...result
      };
    });

    const complete = subjects.length > 0 &&
      subjects.every(subject => subject.complete);

    output.push({
      ...learner,
      marks: undefined,
      subjects,
      complete,
      average: complete
        ? average(subjects.map(subject => subject.score))
        : null,
      incomplete_reason: complete
        ? null
        : 'MISSING_SUBJECT_OR_ASSESSMENT_MARKS'
    });
  }

  const ranked = output
    .filter(learner => learner.complete)
    .sort((a, b) => b.average - a.average);

  let lastAverage = null;
  let rank = 0;

  ranked.forEach((learner, index) => {
    if (
      lastAverage === null ||
      Math.abs(learner.average - lastAverage) > 1e-8
    ) {
      rank = index + 1;
    }

    learner.class_rank = rank;
    learner.class_rank_total = ranked.length;
    lastAverage = learner.average;
  });

  return output.map(learner => ({
    ...learner,
    class_rank: learner.class_rank ?? null,
    class_rank_total: ranked.length
  }));
}

module.exports = {
  average,
  subjectResult,
  calculate
};
