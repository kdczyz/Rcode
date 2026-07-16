console.log('process.versions.electron:', process.versions.electron);
console.log('process.versions.node:', process.versions.node);

// Try to access electron built-in via alternative methods
try {
  console.log('process._linkedBinding("electron_common_v8"):', typeof process._linkedBinding('electron_common_v8'));
} catch(e) { console.log('_linkedBinding failed:', e.message); }

// Check if there's a global electron
console.log('global.electron:', typeof global.electron);
console.log('globalThis.electron:', typeof globalThis.electron);

// List all built-in modules
const builtins = require('module').builtinModules;
console.log('electron-related builtins:', builtins.filter(m => m.includes('electron')));
