function evaluate(x) {
  // DELIBERATE ROUND-1 DEFECT (permutation-controlled-real-defect-ae-develop):
  // card acceptance requires value = x + 205. This delivery_round 1 source
  // returns the original formula plus one so independent HTTP testing can
  // observe the mismatch. Do not treat this as a passing implementation.
  return {feature: 'ae', value: x + 206};
}

module.exports = {evaluate: evaluate};
