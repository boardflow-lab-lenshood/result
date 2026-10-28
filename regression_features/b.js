function evaluate(x) {
  // DELIBERATE REGRESSION R05 DEFECT (delivery round 1 only):
  // card acceptance requires x * 3 + 2. This first-round injection returns
  // x * 3 + 3 so independent HTTP acceptance fails by exactly +1.
  return {feature: 'b', value: x * 3 + 3};
}

module.exports = {evaluate: evaluate};
