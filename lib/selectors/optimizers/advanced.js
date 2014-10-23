var PropertyOptimizer = require('../../properties/optimizer');
var CleanUp = require('./clean-up');
var Splitter = require('../../utils/splitter');

function AdvancedOptimizer(options, context) {
  this.options = options;
  this.minificationsMade = [];
  this.propertyOptimizer = new PropertyOptimizer(this.options.compatibility, this.options.aggressiveMerging, context);
}

function valueMapper(object) { return object.value; }

AdvancedOptimizer.prototype.isSpecial = function (selector) {
  return this.options.compatibility.selectors.special.test(selector);
};

AdvancedOptimizer.prototype.removeDuplicates = function (tokens) {
  var matched = {};
  var forRemoval = [];

  for (var i = 0, l = tokens.length; i < l; i++) {
    var token = tokens[i];
    if (token.kind != 'selector')
      continue;

    var id = token.body.map(valueMapper).join(';') + '@' + token.value.map(valueMapper).join(',');
    var alreadyMatched = matched[id];

    if (alreadyMatched) {
      forRemoval.push(alreadyMatched[0]);
      alreadyMatched.unshift(i);
    } else {
      matched[id] = [i];
    }
  }

  forRemoval = forRemoval.sort(function(a, b) {
    return a > b ? 1 : -1;
  });

  for (var j = 0, n = forRemoval.length; j < n; j++) {
    tokens.splice(forRemoval[j] - j, 1);
  }

  this.minificationsMade.unshift(forRemoval.length > 0);
};

AdvancedOptimizer.prototype.mergeAdjacent = function (tokens) {
  var forRemoval = [];
  var lastToken = { selector: null, body: null };

  for (var i = 0, l = tokens.length; i < l; i++) {
    var token = tokens[i];

    if (token.kind != 'selector')
      continue;

    // TODO: broken due to joining/splitting
    if (lastToken.kind == 'selector' && token.value.map(valueMapper).join(',') == lastToken.value.map(valueMapper).join(',')) {
      var joinAt = [lastToken.body.length];
      lastToken.body = this.propertyOptimizer.process(token.value, lastToken.body.concat(token.body), joinAt, true);
      forRemoval.push(i);
      // TODO: broken due to joining/splitting
    } else if (lastToken.body && token.body.map(valueMapper).join(';') == lastToken.body.map(valueMapper).join(';') && !this.isSpecial(token.value.map(valueMapper).join(',')) && !this.isSpecial(lastToken.value.map(valueMapper).join(','), this.options)) {
      lastToken.value = CleanUp.selectors(lastToken.value.concat(token.value));
      forRemoval.push(i);
    } else {
      lastToken = token;
    }
  }

  for (var j = 0, m = forRemoval.length; j < m; j++) {
    tokens.splice(forRemoval[j] - j, 1);
  }

  this.minificationsMade.unshift(forRemoval.length > 0);
};

AdvancedOptimizer.prototype.reduceNonAdjacent = function (tokens) {
  var candidates = {};
  var moreThanOnce = [];

  for (var i = tokens.length - 1; i >= 0; i--) {
    var token = tokens[i];

    if (token.kind != 'selector')
      continue;

    var complexSelector = token.value;
    var selectors = complexSelector.length > 1 && !this.isSpecial(complexSelector.map(valueMapper).join(','), this.options) ?
      [complexSelector.map(valueMapper).join(',')].concat(complexSelector.map(valueMapper)) :
      [complexSelector.map(valueMapper).join(',')];

    for (var j = 0, m = selectors.length; j < m; j++) {
      var selector = selectors[j];

      if (!candidates[selector])
        candidates[selector] = [];
      else
        moreThanOnce.push(selector);

      // TODO: broken due to joining/splitting
      candidates[selector].push({
        where: i,
        partial: selector != complexSelector.map(valueMapper).join(',')
      });
    }
  }

  var reducedInSimple = this.reduceSimpleNonAdjacentCases(tokens, moreThanOnce, candidates);
  var reducedInComplex = this.reduceComplexNonAdjacentCases(tokens, candidates);

  this.minificationsMade.unshift(reducedInSimple || reducedInComplex);
};

AdvancedOptimizer.prototype.reduceSimpleNonAdjacentCases = function (tokens, matches, positions) {
  var reduced = false;

  for (var i = 0, l = matches.length; i < l; i++) {
    var selector = matches[i];
    var data = positions[selector];

    if (data.length < 2)
      continue;

    /* jshint loopfunc: true */
    this.reduceSelector(tokens, selector, data, {
      filterOut: function (idx, bodies) {
        return data[idx].partial && bodies.length === 0;
      },
      callback: function (token, newBody, processedCount, tokenIdx) {
        if (!data[processedCount - tokenIdx - 1].partial) {
          token.body = newBody;
          reduced = true;
        }
      }
    });
  }

  return reduced;
};

AdvancedOptimizer.prototype.reduceComplexNonAdjacentCases = function (tokens, positions) {
  var reduced = false;

  allSelectors:
  for (var complexSelector in positions) {
    if (complexSelector.indexOf(',') == -1)
      continue;

    var into = positions[complexSelector];
    var intoPosition = into[into.length - 1].where;
    var intoToken = tokens[intoPosition];

    // TODO: broken due to joining/splitting
    var selectors = this.isSpecial(complexSelector) ?
      [complexSelector] :
      new Splitter(',').split(complexSelector);
    var reducedBodies = [];

    for (var j = 0, m = selectors.length; j < m; j++) {
      var selector = selectors[j];
      var data = positions[selector];

      if (data.length < 2)
        continue allSelectors;

      /* jshint loopfunc: true */
      this.reduceSelector(tokens, selector, data, {
        filterOut: function (idx) {
          return data[idx].where < intoPosition;
        },
        callback: function (token, newBody, processedCount, tokenIdx) {
          if (tokenIdx === 0)
            reducedBodies.push(newBody.map(valueMapper).join(';'));
        }
      });

      if (reducedBodies[reducedBodies.length - 1] != reducedBodies[0])
        continue allSelectors;
    }

    intoToken.body = reducedBodies[0].split(';').map(function (property) {
      return { value: property };
    });
    reduced = true;
  }

  return reduced;
};

AdvancedOptimizer.prototype.reduceSelector = function (tokens, selector, data, options) {
  var bodies = [];
  var joinsAt = [];
  var splitBodies = [];
  var processedTokens = [];

  for (var j = data.length - 1, m = 0; j >= 0; j--) {
    if (options.filterOut(j, bodies))
      continue;

    var where = data[j].where;
    var token = tokens[where];
    var body = token.body;

    bodies = bodies.concat(body);
    splitBodies.push(body.map(valueMapper));
    processedTokens.push(where);
  }

  for (j = 0, m = splitBodies.length; j < m; j++) {
    if (splitBodies[j].length > 0)
      joinsAt.push((joinsAt[j - 1] || 0) + splitBodies[j].length);
  }

  var optimizedBody = this.propertyOptimizer.process(selector, bodies, joinsAt, false);
  var optimizedProperties = optimizedBody;

  var processedCount = processedTokens.length;
  var propertyIdx = optimizedProperties.length - 1;
  var tokenIdx = processedCount - 1;

  while (tokenIdx >= 0) {
     if ((tokenIdx === 0 || (optimizedProperties[propertyIdx] && splitBodies[tokenIdx].indexOf(optimizedProperties[propertyIdx].value) > -1)) && propertyIdx > -1) {
      propertyIdx--;
      continue;
    }

    var newBody = optimizedProperties.splice(propertyIdx + 1);
    options.callback(tokens[processedTokens[tokenIdx]], newBody, processedCount, tokenIdx);

    tokenIdx--;
  }
};

function optimizeProperties(tokens, propertyOptimizer) {
  for (var i = 0, l = tokens.length; i < l; i++) {
    var token = tokens[i];

    if (token.kind == 'selector') {
      token.body = propertyOptimizer.process(token.value, token.body, false, true);
    } else if (token.kind == 'block') {
      optimizeProperties(token.body, propertyOptimizer);
    }
  }
}

AdvancedOptimizer.prototype.optimize = function (tokens) {
  var self = this;

  function _optimize(tokens) {
    tokens.forEach(function (token) {
      if (token.kind == 'block')
        _optimize(token.body);
    });

    optimizeProperties(tokens, self.propertyOptimizer);

    self.removeDuplicates(tokens);
    self.mergeAdjacent(tokens);
    self.reduceNonAdjacent(tokens);

    self.removeDuplicates(tokens);
    self.mergeAdjacent(tokens);
  }

  _optimize(tokens);
};

module.exports = AdvancedOptimizer;