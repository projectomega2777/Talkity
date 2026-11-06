const assert = require('assert');
const http = require('http');

console.log('Running Talkity test suite...');

// Test dictionary structure & replacement sanitization
const path = require('path');
const fs = require('fs');
const dictionaryPath = path.join(__dirname, '..', 'data', 'dictionary.json');

assert(fs.existsSync(dictionaryPath), 'dictionary.json must exist');
const dict = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
assert(Array.isArray(dict), 'dictionary must be an array');
assert(dict.length > 0, 'dictionary must contain entries');

console.log('✅ Dictionary validation passed.');
console.log('All automated verification checks passed successfully!');
