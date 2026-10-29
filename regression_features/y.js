function evaluate(x) {
  // DELIBERATE round-1 source mismatch: card formula is x + 117.
  // Authorized permutation input retains x + 118 until a later repair round.
  return {feature: 'y', value: x + 118};
}

module.exports = {evaluate: evaluate};
