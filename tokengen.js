const crypto = require('crypto');

const input = "GFS2025maxdouAdmin";
const token = crypto.createHash('sha256').update(input).digest('hex');

console.log(token);