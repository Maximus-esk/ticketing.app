const crypto = require('crypto');

const input = "GFS2025tuerst3Scanner";
const token = crypto.createHash('sha256').update(input).digest('hex');

console.log(token);
