console.log('NODE_PATH:', process.env.NODE_PATH);
console.log('module.paths:', module.paths);
console.log('electron index.js:', require.resolve('electron'));
const electron = require('electron');
console.log('typeof electron:', typeof electron);
console.log('is string (path):', typeof electron === 'string');
if (typeof electron === 'string') console.log('path value:', electron);
