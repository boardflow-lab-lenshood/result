function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive permutation-controlled-real-defect-w-develop,
  // delivery_round 1 only): the card formula is x + 115. This round intentionally
  // returns one above it so independent acceptance fails. Repair on round 2+.
  return {feature: 'w', value: x + 116};
}

module.exports = {evaluate: evaluate};
