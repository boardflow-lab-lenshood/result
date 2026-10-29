function evaluate(x) {
  // DELIBERATE TEST DEFECT (permutation-controlled-real-defect-v, delivery_round 1 only):
  // original card formula is x + 114. This round returns x + 115 so an independent
  // acceptance test observes the mismatch. Do not treat this as a passing implementation.
  return {feature: 'v', value: x + 115};
}

module.exports = {evaluate: evaluate};
