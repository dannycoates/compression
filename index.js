/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts')
var Buffer = require('safe-buffer').Buffer
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')
var isUint8Array = require('@stdlib/assert-is-uint8array')
const { ServerResponse } = require('http')

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * Module variables.
 * @private
 */

var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

function compression (options) {
  var opts = options || {}

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)

  if (threshold == null) {
    threshold = 1024
  }

  function noop () { }

  return function compression (req, res, next) {
    var ended = false
    var length
    var listeners = []
    var stream

    var _end = res.end
    var _on = res.on
    var _write = res.write

    // flush
    res.flush = function flush () {
      if (stream) {
        stream.flush()
      }
    }

    // proxy

    res.write = function write (chunk, encoding, callback) {
      if (chunk === null) {
        // throw ERR_STREAM_NULL_VALUES
        return _write.call(this, chunk, encoding, callback)
      } else if (typeof chunk === 'string' || isUint8Array(chunk)) {
        // noop
      } else {
        // throw ERR_INVALID_ARG_TYPE
        return _write.call(this, chunk, encoding, callback)
      }

      if (!callback && typeof encoding === 'function') {
        callback = encoding
        encoding = undefined
      }

      if (typeof callback !== 'function') {
        callback = noop
      }

      if (res.destroyed || res.finished || ended) {
        // HACK: node doesn't expose internal errors,
        // we need to fake response to throw underlying errors type
        var fakeRes = new ServerResponse({})
        if (!res.destroyed) {
          fakeRes.destroyed = fakeRes.finished = true
        } else {
          fakeRes.destroyed = true
        }
        // throw ERR_STREAM_DESTROYED or ERR_STREAM_WRITE_AFTER_END
        return _write.call(fakeRes, chunk, encoding, callback)
      }

      if (!this._header) {
        this._implicitHeader()
      }

      return stream
        ? stream.write(toBuffer(chunk, encoding), encoding, callback)
        : _write.call(this, chunk, encoding, callback)
    }

    res.end = function end (chunk, encoding, callback) {
      if (!callback) {
        if (typeof chunk === 'function') {
          callback = chunk
          chunk = encoding = undefined
        } else if (typeof encoding === 'function') {
          callback = encoding
          encoding = undefined
        }
      }

      if (typeof callback !== 'function') {
        callback = noop
      }

      if (this.destroyed || this.finished || ended) {
        this.finished = ended
        // throw ERR_STREAM_WRITE_AFTER_END or ERR_STREAM_ALREADY_FINISHED
        return _end.call(this, chunk, encoding, callback)
      }

      if (!this._header) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding)
        }

        this._implicitHeader()
      }

      if (!stream) {
        return _end.call(this, chunk, encoding, callback)
      }

      // mark ended
      ended = true

      // write Buffer for Node.js 0.8
      return chunk
        ? stream.end(toBuffer(chunk, encoding), encoding, callback)
        : stream.end(callback)
    }

    res.on = function on (type, listener) {
      if (!listeners || type !== 'drain') {
        return _on.call(this, type, listener)
      }

      if (stream) {
        return stream.on(type, listener)
      }

      // buffer listeners for future stream
      listeners.push([type, listener])

      return this
    }

    function nocompress (msg) {
      debug('no compression: %s', msg)
      addListeners(res, _on, listeners)
      listeners = null
    }

    onHeaders(res, function onResponseHeaders () {
      // determine if request is filtered
      if (!filter(req, res)) {
        nocompress('filtered')
        return
      }

      // determine if the entity should be transformed
      if (!shouldTransform(req, res)) {
        nocompress('no transform')
        return
      }

      // vary
      vary(res, 'Accept-Encoding')

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) {
        nocompress('size below threshold')
        return
      }

      var encoding = res.getHeader('Content-Encoding') || 'identity'

      // already encoded
      if (encoding !== 'identity') {
        nocompress('already encoded')
        return
      }

      // head
      if (req.method === 'HEAD') {
        nocompress('HEAD request')
        return
      }

      // compression method
      var accept = accepts(req)
      var method = accept.encoding(['br', 'gzip', 'deflate', 'identity'])

      // we really don't prefer deflate
      if (method === 'deflate' && accept.encoding(['gzip'])) {
        method = accept.encoding(['gzip', 'identity'])
      }

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      stream = method === 'br'
        ? zlib.createBrotliCompress()
        : method === 'gzip'
        ? zlib.createGzip(opts)
        : zlib.createDeflate(opts)

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method)
      res.removeHeader('Content-Length')

      // compression
      stream.on('data', function onStreamData (chunk) {
        if (_write.call(res, chunk) === false) {
          stream.pause()
        }
      })

      stream.on('end', function onStreamEnd () {
        _end.call(res)
      })

      _on.call(res, 'drain', function onResponseDrain () {
        stream.resume()
      })
    })

    next()
  }
}

/**
 * Add bufferred listeners to stream
 * @private
 */

function addListeners (stream, on, listeners) {
  for (var i = 0; i < listeners.length; i++) {
    on.apply(stream, listeners[i])
  }
}

/**
 * Get the length of a given chunk
 */

function chunkLength (chunk, encoding) {
  if (!chunk) {
    return 0
  }

  return !Buffer.isBuffer(chunk)
    ? Buffer.byteLength(chunk, encoding)
    : chunk.length
}

/**
 * Default filter function.
 * @private
 */

function shouldCompress (req, res) {
  var type = res.getHeader('Content-Type')

  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type)
    return false
  }

  return true
}

/**
 * Determine if the entity should be transformed.
 * @private
 */

function shouldTransform (req, res) {
  var cacheControl = res.getHeader('Cache-Control')

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl ||
    !cacheControlNoTransformRegExp.test(cacheControl)
}

/**
 * Coerce arguments to Buffer
 * @private
 */

function toBuffer (chunk, encoding) {
  return !Buffer.isBuffer(chunk)
    ? Buffer.from(chunk, encoding)
    : chunk
}