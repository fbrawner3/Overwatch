'use strict';

// Local-env fallback. If the better-sqlite3 native binding isn't built for this
// Node version (common on a Windows dev box without MSVC build tools), shim it
// with the built-in node:sqlite so the suite still runs. On CI and on heizou
// (Linux, Node 22) better-sqlite3 loads normally and this file is a no-op.
let nativeOk = false;
try {
  const B = require('better-sqlite3');
  new B(':memory:').close(); // binding loads lazily in the constructor, not at require
  nativeOk = true;
} catch { /* fall through to shim */ }

if (!nativeOk) {
  const Module = require('node:module');
  const { DatabaseSync } = require('node:sqlite');

  class BetterSqlite3Compat {
    constructor(path) { this._db = new DatabaseSync(path); }
    exec(sql) { this._db.exec(sql); return this; }
    prepare(sql) { return this._db.prepare(sql); }
    pragma(s) { try { this._db.exec('PRAGMA ' + s); } catch {} }
    transaction(fn) {
      const db = this._db;
      return function (...args) {
        db.exec('BEGIN');
        try { const r = fn.apply(this, args); db.exec('COMMIT'); return r; }
        catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      };
    }
    close() { this._db.close(); }
  }

  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'better-sqlite3') return BetterSqlite3Compat;
    return origLoad.call(this, request, ...rest);
  };
  console.warn('[test] better-sqlite3 native binding unavailable — using node:sqlite shim');
}
