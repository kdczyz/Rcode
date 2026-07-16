const electron = require('electron');
console.log('electron keys:', Object.keys(electron).slice(0, 20));
console.log('app:', typeof electron.app);
console.log('BrowserWindow:', typeof electron.BrowserWindow);
console.log('app.isReady?:', electron.app && typeof electron.app.isReady);
