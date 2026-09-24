const { runSplit, USAGE } = require('./split');
try { runSplit(process.argv.slice(2)); }
catch (error) { console.error(`错误：${error.message}`); console.error(USAGE); process.exit(1); }
