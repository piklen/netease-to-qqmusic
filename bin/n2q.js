#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

run(process.argv.slice(2)).catch((error) => {
  const { cleanError } = require('../src/lib/util');
  const { fail } = require('../src/lib/ui');
  fail(cleanError(error));
  if (process.env.DEBUG) console.error(error);
  process.exitCode = 1;
});
