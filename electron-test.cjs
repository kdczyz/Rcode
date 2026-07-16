console.log('Electron require test:');
const electron = require('electron');
console.log('electron keys:', Object.keys(electron));
console.log('app:', typeof electron.app);
console.log('BrowserWindow:', typeof electron.BrowserWindow);
