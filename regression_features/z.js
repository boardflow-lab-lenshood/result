function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive permutation-controlled-real-defect-z-develop,
  // delivery_round 1 only): the card formula is x + 118. This round intentionally
  // returns one above it so independent acceptance fails. Repair on round 2+.
  return {feature: 'z', value: x + 119};
}

module.exports = {evaluate: evaluate};
