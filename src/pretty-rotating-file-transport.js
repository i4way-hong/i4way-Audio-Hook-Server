'use strict';
/* eslint-disable */
const { PassThrough } = require('stream');
const path = require('path');

module.exports = async function (opts = {}) {
  // opts: { dir, prefix, maxMegabytes, retentionDays, prettyOptions }
  const prettyFactory = require('pino-pretty');
  const rotatingFactory = require(path.resolve(__dirname, './rotating-file-transport.js'));

  const input = new PassThrough();
  const pretty = prettyFactory({
    colorize: false,
    ignore: 'pid,hostname',
    translateTime: 'SYS:HH:MM:ss.l',
    ...(opts.prettyOptions || {})
  });
  const rotating = await rotatingFactory({
    dir: opts.dir,
    prefix: opts.prefix || 'app',
    maxMegabytes: opts.maxMegabytes || 50,
    retentionDays: opts.retentionDays || 7,
  });

  input.pipe(pretty).pipe(rotating);
  return input;
};
