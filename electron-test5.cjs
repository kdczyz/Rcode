// Try requiring browser_init which might expose electron APIs
try {
  const browser = require('electron/js2c/browser_init');
  console.log('browser_init keys:', Object.keys(browser).slice(0, 20));
  console.log('has app:', 'app' in browser);
} catch(e) { console.log('browser_init:', e.message); }

// try to see what electron/js2c/node_init exports  
try {
  const nodeInit = require('electron/js2c/node_init');
  console.log('node_init keys:', Object.keys(nodeInit).slice(0, 20));
} catch(e) { console.log('node_init:', e.message); }
