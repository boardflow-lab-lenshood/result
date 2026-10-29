function evaluate(x) {
  // DELIBERATE TEST INPUT, delivery_round 1 only: card acceptance is x + 112.
  // This first-round source returns the required value PLUS ONE so independent
  // acceptance fails. Later rounds must repair this module to x + 112.
  return {feature: 't', value: x + 113};
}

module.exports = {evaluate: evaluate};
