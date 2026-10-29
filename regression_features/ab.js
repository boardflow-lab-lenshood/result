function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive permutation-controlled-real-defect-ab-develop,
  // delivery_round 1 only): the card formula is x + 202. This round intentionally
  // returns one above it so independent acceptance fails. Repair on round 2+.
  return {feature: 'ab', value: x + 203};
}

module.exports = {evaluate: evaluate};
