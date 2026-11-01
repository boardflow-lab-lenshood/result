var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    path = require('path'),
    fs = require('fs'),
    cookieParser = require('cookie-parser'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server);

var port = process.env.PORT || 4000;

io.on('connection', function (socket) {

  socket.emit('message', { text : 'Welcome!' });

  socket.on('subscribe', function (data) {
    socket.join(data.channel);
  });
});

var pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000
});
pool.on('error', function(err) {
  console.error('PostgreSQL pool error', {error: err.message, code: err.code});
});

var shuttingDown = false;
var voteBroadcastTimer = null;
var voteBroadcastRelease = null;

async.retry(
  {times: 1000, interval: 1000},
  function(callback) {
    if (shuttingDown) {
      callback(new Error('shutdown'));
      return;
    }
    pool.connect(function(err, client, done) {
      if (err) {
        console.error("Waiting for db");
      }
      callback(err, client, done);
    });
  },
  function(err, client, done) {
    if (err) {
      return console.error("Giving up");
    }
    console.log("Connected to db");
    voteBroadcastRelease = done;
    getVotes(client);
  }
);

function getVotes(client) {
  if (shuttingDown) {
    return;
  }
  client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
    if (shuttingDown) {
      return;
    }
    if (err) {
      console.error("Error performing query: " + err);
    } else {
      var votes = collectVotesFromResult(result);
      io.sockets.emit("scores", JSON.stringify(votes));
    }

    voteBroadcastTimer = setTimeout(function() {getVotes(client) }, 1000);
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error('Shutting down result service', {signal: signal});
  if (voteBroadcastTimer) {
    clearTimeout(voteBroadcastTimer);
    voteBroadcastTimer = null;
  }
  if (typeof voteBroadcastRelease === 'function') {
    try {
      voteBroadcastRelease();
    } catch (err) {
      console.error('Vote broadcast release failed', {code: err.code || 'release_failed'});
    }
    voteBroadcastRelease = null;
  }
  try {
    server.close();
  } catch (err) {
    console.error('HTTP server close failed', {code: err.code || 'server_close_failed'});
  }
  try {
    io.close();
  } catch (err) {
    console.error('Socket.IO close failed', {code: err.code || 'socket_close_failed'});
  }
  var finished = false;
  function finish() {
    if (finished) {
      return;
    }
    finished = true;
    process.exit(0);
  }
  var timer = setTimeout(function() {
    console.error('Shutdown timed out; forcing exit');
    finish();
  }, 1500);
  timer.unref();
  pool.end().then(function() {
    clearTimeout(timer);
    finish();
  }).catch(function(err) {
    console.error('PostgreSQL pool shutdown failed', {code: err.code || 'pool_end_failed'});
    clearTimeout(timer);
    finish();
  });
}

process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT', function() { shutdown('SIGINT'); });

function collectVotesFromResult(result) {
  var votes = {a: 0, b: 0};

  result.rows.forEach(function (row) {
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

function queryVoteCounts(callback) {
  pool.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, collectVotesFromResult(result));
  });
}

function summarizeVoteCounts(votes) {
  var counts = {a: votes.a, b: votes.b};
  var total = counts.a + counts.b;
  var leader = null;
  if (counts.a > counts.b) {
    leader = 'a';
  } else if (counts.b > counts.a) {
    leader = 'b';
  }
  return {
    counts: counts,
    total: total,
    leader: leader
  };
}

app.use(cookieParser());
app.use(express.urlencoded());
app.use(express.static(__dirname + '/views'));

app.get('/', function (req, res) {
  res.sendFile(path.resolve(__dirname + '/views/index.html'));
});

var FEATURE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
var FEATURES_DIR = path.join(__dirname, 'regression_features');

function regressionError(res, status, error) {
  res.status(status).json({error: error, service: 'result'});
}

app.get('/api/regression/:name', function (req, res) {
  var name = req.params.name;
  var rawValue = req.query.x;
  if (typeof rawValue !== 'string' || !/^-?\d+$/.test(rawValue)) {
    regressionError(res, 400, 'invalid_integer');
    return;
  }
  if (!FEATURE_NAME.test(name)) {
    regressionError(res, 400, 'invalid_feature');
    return;
  }
  var featurePath = path.resolve(FEATURES_DIR, name + '.js');
  if (path.dirname(featurePath) !== path.resolve(FEATURES_DIR)) {
    regressionError(res, 400, 'invalid_feature');
    return;
  }
  if (!fs.existsSync(featurePath)) {
    regressionError(res, 404, 'feature_not_found');
    return;
  }
  var evaluate;
  try {
    delete require.cache[require.resolve(featurePath)];
    evaluate = require(featurePath).evaluate;
    if (typeof evaluate !== 'function') {
      throw new TypeError('feature evaluate is not callable');
    }
    var payload = evaluate(Number(rawValue));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('feature payload is not an object');
    }
    res.json(payload);
  } catch (err) {
    console.error('Regression feature failed', {
      feature: name,
      code: 'feature_failed'
    });
    regressionError(res, 500, 'feature_failed');
  }
});

function sendVoteReadFailure(res, err, logMessage) {
  console.error(logMessage, {
    error: err.message,
    code: err.code
  });
  res.status(503).json({
    error: 'database_unavailable',
    service: 'result'
  });
}

app.get('/api/results', function (req, res) {
  queryVoteCounts(function(err, votes) {
    if (err) {
      sendVoteReadFailure(res, err, 'Failed to read vote counts');
      return;
    }
    res.json({a: votes.a, b: votes.b});
  });
});

app.get('/api/uat/result-summary', function (req, res) {
  queryVoteCounts(function(err, votes) {
    if (err) {
      sendVoteReadFailure(res, err, 'Failed to read result summary');
      return;
    }
    res.json(summarizeVoteCounts(votes));
  });
});

server.listen(port, function () {
  var port = server.address().port;
  console.log('App running on port ' + port);
});

app.get('/healthz', function(req, res) {
  pool.query('SELECT 1', function(err) {
    if (err) {
      console.error('PostgreSQL readiness check failed', err);
      return res.status(503).json({status: 'unavailable', service: 'result'});
    }
    res.json({status: 'ok', service: 'result'});
  });
});

module.exports = {
  app: app,
  server: server,
  pool: pool,
  collectVotesFromResult: collectVotesFromResult,
  queryVoteCounts: queryVoteCounts,
  summarizeVoteCounts: summarizeVoteCounts
};
