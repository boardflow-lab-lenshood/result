function evaluate(x) {
  // DELIBERATE TEST DEFECT (delivery_round 1 only, directive
  // next-queue-first-round-real-defect-o): card acceptance requires
  // value = x + 107. This first round intentionally returns one more so the
  // independent tester observes a real failure. Do not treat this as passing.
  return {feature: 'o', value: x + 108};
}

module.exports = {evaluate: evaluate};
