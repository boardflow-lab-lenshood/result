const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// Loaded only by the summary test's child server; never connects to PostgreSQL.
class SummaryPool extends EventEmitter {
  constructor() {
    super();
    this.counts = JSON.parse(process.env.TEST_SUMMARY_COUNTS);
  }

  query(sql, params, callback) {
    if (typeof params === 'function') callback = params;
    assert.equal(sql, 'SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote');
    const rows = Object.entries(this.counts)
      .filter(([, count]) => count > 0)
      .map(([vote, count]) => ({ vote, count: String(count) }));
    const error = process.env.TEST_SUMMARY_ERROR === 'query'
      ? Object.assign(new Error('isolated query failure'), { code: 'XX000' })
      : null;
    queueMicrotask(() => callback(error, { rows }));
  }

  connect(callback) {
    queueMicrotask(() => callback(null, this, () => {}));
  }

  end() {
    return Promise.resolve();
  }
}

require('pg').Pool = SummaryPool;
