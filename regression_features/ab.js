function evaluate(x) {
  // DELIBERATE TEST DEFECT (directive empty-failed-real-worker-cleanup-source-AB-DEVELOP,
  // delivery_round 2 only): the card formula is x + 202. This round intentionally
  // returns one above it so independent acceptance fails. Repair after round 2.
  return {feature: 'ab', value: x + 203};
}

module.exports = {evaluate: evaluate};
