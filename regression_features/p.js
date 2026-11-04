function evaluate(x) {
  // DELIBERATE TEST INPUT, delivery_round 1 only: card acceptance is x + 108.
  // This first-round source returns the required value PLUS ONE so independent
  // acceptance fails. Later rounds must repair this module to x + 108.
  return {feature: 'p', value: x + 109};
}

module.exports = {evaluate: evaluate};
