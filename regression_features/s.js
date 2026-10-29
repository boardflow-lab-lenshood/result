function evaluate(x) {
  // DELIBERATE TEST INPUT, delivery_round 1 only: card acceptance is x + 111.
  // This first-round source returns the required value PLUS ONE so independent
  // acceptance fails. Later rounds must repair this module to x + 111.
  return {feature: 's', value: x + 112};
}

module.exports = {evaluate: evaluate};
