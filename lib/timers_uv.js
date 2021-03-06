// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Timer = process.binding('timer_wrap').Timer;
var L = require('_linklist');
var assert = require('assert').ok;

var debug;
if (process.env.NODE_DEBUG && /timer/.test(process.env.NODE_DEBUG)) {
  debug = function() { require('util').error.apply(this, arguments); };
} else {
  debug = function() { };
}


// IDLE TIMEOUTS
//
// Because often many sockets will have the same idle timeout we will not
// use one timeout watcher per item. It is too much overhead.  Instead
// we'll use a single watcher for all sockets with the same timeout value
// and a linked list. This technique is described in the libev manual:
// http://pod.tst.eu/http://cvs.schmorp.de/libev/ev.pod#Be_smart_about_timeouts

// Object containing all lists, timers
// key = time in milliseconds
// value = list
var lists = {};


// the main function - creates lists on demand and the watchers associated
// with them.
function insert(item, msecs) {
  item._idleStart = new Date();
  item._idleTimeout = msecs;

  if (msecs < 0) return;

  var list;

  if (lists[msecs]) {
    list = lists[msecs];
  } else {
    list = new Timer();
    list.start(msecs, 0);

    L.init(list);

    lists[msecs] = list;

    list.ontimeout = function() {
      debug('timeout callback ' + msecs);
      // TODO - don't stop and start the watcher all the time.
      // just set its repeat
      var now = new Date();
      debug('now: ' + now);

      var first;
      while (first = L.peek(list)) {
        var diff = now - first._idleStart;
        if (diff + 1 < msecs) {
          list.start(diff, 0);
          debug(msecs + ' list wait because diff is ' + diff);
          return;
        } else {
          L.remove(first);
          assert(first !== L.peek(list));
          if (first._onTimeout) first._onTimeout();
        }
      }

      debug(msecs + ' list empty');
      assert(L.isEmpty(list));
      list.close();
      delete lists[msecs];
    };
  }

  L.append(list, item);
  assert(!L.isEmpty(list)); // list is not empty
}


var unenroll = exports.unenroll = function(item) {
  L.remove(item);

  var list = lists[item._idleTimeout];
  // if empty then stop the watcher
  debug('unenroll');
  if (list && L.isEmpty(list)) {
    debug('unenroll: list empty');
    list.close();
    delete lists[item._idleTimeout];
  }
};


// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  // if this item was already in a list somewhere
  // then we should unenroll it from that
  if (item._idleNext) unenroll(item);

  item._idleTimeout = msecs;
  L.init(item);
};


// call this whenever the item is active (not idle)
// it will reset its timeout.
exports.active = function(item) {
  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    var list = lists[msecs];
    if (item._idleNext == item) {
      insert(item, msecs);
    } else {
      item._idleStart = new Date();
      L.append(list, item);
    }
  }
};


/*
 * DOM-style timers
 */


exports.setTimeout = function(callback, after) {
  var timer, c, args;

  if (after <= 0) {
    // Use the slow case for after == 0
    timer = new Timer();
    timer.ontimeout = callback;

    args = Array.prototype.slice.call(arguments, 2);
    timer._onTimeout = function() {
      callback.apply(timer, args);
      timer.close();
    }

    timer.start(0, 0);
  } else {
    timer = { _idleTimeout: after };
    timer._idlePrev = timer;
    timer._idleNext = timer;

    if (arguments.length <= 2) {
      timer._onTimeout = callback;
    } else {
      /*
       * Sometimes setTimeout is called with arguments, EG
       *
       *   setTimeout(callback, 2000, "hello", "world")
       *
       * If that's the case we need to call the callback with
       * those args. The overhead of an extra closure is not
       * desired in the normal case.
       */
      args = Array.prototype.slice.call(arguments, 2);
      timer._onTimeout = function() {
        callback.apply(timer, args);
      }
    }

    exports.active(timer);
  }

  return timer;
};


exports.clearTimeout = function(timer) {
  if (timer && (timer.ontimeout || timer._onTimeout)) {
    timer.ontimeout = timer._onTimeout = null;
    if (timer instanceof Timer) {
      timer.close(); // for after === 0
    } else {
      exports.unenroll(timer);
    }
  }
};


exports.setInterval = function(callback, repeat) {
  var timer = new Timer();

  var args = Array.prototype.slice.call(arguments, 2);
  timer.ontimeout = function() {
    callback.apply(timer, args);
  }

  timer.start(repeat, repeat ? repeat : 1);
  return timer;
};


exports.clearInterval = function(timer) {
  if (timer instanceof Timer) {
    timer.ontimeout = null;
    timer.close();
  }
};
