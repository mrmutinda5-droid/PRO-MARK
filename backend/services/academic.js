function gradeFor(mark, bands) {
  const n = Number(mark);
  if (!Number.isFinite(n)) return null;
  return bands.find(b => n >= Number(b.min_mark) && n <= Number(b.max_mark)) || null;
}
function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
}
function weighted(values) {
  const usable = values.filter(x => Number.isFinite(Number(x.mark)) && Number(x.weight) > 0);
  const totalWeight = usable.reduce((a,x)=>a+Number(x.weight),0);
  if (!totalWeight) return null;
  return usable.reduce((a,x)=>a+Number(x.mark)*Number(x.weight),0)/totalWeight;
}
module.exports = {gradeFor, average, weighted};
