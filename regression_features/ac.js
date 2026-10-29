function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive empty-failed-real-worker-cleanup-source-AC-DEVELOP,
  // delivery_round 2 only): the card formula is x + 203. This round intentionally
  // returns one above it so independent acceptance fails. Repair after round 2.
  return {feature: 'ac', value: x + 204};
}

module.exports = {evaluate: evaluate};
