var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    path = require('path'),
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

async.retry(
  {times: 1000, interval: 1000},
  function(callback) {
    pool.connect(function(err, client, done) {
      if (err) {
        console.error("Waiting for db");
      }
      callback(err, client);
    });
  },
  function(err, client) {
    if (err) {
      return console.error("Giving up");
    }
    console.log("Connected to db");
    getVotes(client);
  }
);

function getVotes(client) {
  client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
    if (err) {
      console.error("Error performing query: " + err);
    } else {
      var votes = collectVotesFromResult(result);
      io.sockets.emit("scores", JSON.stringify(votes));
    }

    setTimeout(function() {getVotes(client) }, 1000);
  });
}

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

app.use(cookieParser());
app.use(express.urlencoded());
app.use(express.static(__dirname + '/views'));

app.get('/', function (req, res) {
  res.sendFile(path.resolve(__dirname + '/views/index.html'));
});

app.get('/api/results', function (req, res) {
  queryVoteCounts(function(err, votes) {
    if (err) {
      console.error('Failed to read vote counts', {
        error: err.message,
        code: err.code
      });
      res.status(503).json({
        error: 'database_unavailable',
        service: 'result'
      });
      return;
    }
    res.json({a: votes.a, b: votes.b});
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
  queryVoteCounts: queryVoteCounts
};
