const { execSync } = require('child_process');
const { existsSync, readdirSync } = require('fs');
const { join } = require('path');

console.log('Testing process detection...');
try {
  const ps = execSync(
    'powershell -Command "Get-Process -Name afterfx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"',
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  console.log('Process result:', ps);
  console.log('Exists:', ps ? existsSync(ps) : 'no path');
  if (ps && existsSync(ps)) {
    console.log('FOUND VIA PROCESS:', ps);
  }
} catch(e) {
  console.log('Error:', e.message);
}

console.log('\nTesting drive scan...');
const drives = ['C:', 'D:', 'E:', 'F:'];
for (const drive of drives) {
  try {
    const exists = existsSync(drive);
    console.log(drive, 'exists:', exists);
    if (exists) {
      const adobeRoot = join(drive, '\\Program Files', 'Adobe');
      const adobeExists = existsSync(adobeRoot);
      console.log('  Adobe root:', adobeRoot, 'exists:', adobeExists);
      if (adobeExists) {
        const entries = readdirSync(adobeRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('Adobe After Effects')) {
            console.log('  Found AE:', entry.name);
            const supportDir = join(adobeRoot, entry.name, 'Support Files');
            const afterFxExe = join(supportDir, 'AfterFX.exe');
            console.log('    AfterFX.exe exists:', existsSync(afterFxExe));
          }
        }
      }
    }
  } catch(e) {
    console.log(drive, 'error:', e.message);
  }
}