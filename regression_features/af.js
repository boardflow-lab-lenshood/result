function evaluate(x) {
  // DELIBERATE ROUND-1 DEFECT (permutation-controlled-real-defect-af-develop):
  // card acceptance requires value = x + 206. This delivery_round 1 source
  // returns the original formula plus one so independent HTTP testing can
  // observe the mismatch. Do not treat this as a passing implementation.
  return {feature: 'af', value: x + 207};
}

module.exports = {evaluate: evaluate};
