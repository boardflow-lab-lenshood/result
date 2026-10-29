function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive permutation-controlled-real-defect-ac-develop,
  // delivery_round 1 only): the card formula is x + 203. This round intentionally
  // returns one above it so independent acceptance fails. Repair on round 2+.
  return {feature: 'ac', value: x + 204};
}

module.exports = {evaluate: evaluate};
