// TEMPORARY diagnosis of the ancestry listing on Windows (removed before merge)
import { test } from 'node:test';
import { ownChain, windowsEnv } from '../src/lib/ancestry.mjs';
import { WMI_LIST, listProcesses } from '../src/lib/proctree.mjs';

test('DIAG 3: the module-free listing', { skip: process.platform !== 'win32' }, async () => {
  const base = windowsEnv('C:\\Windows');
  const t = async (label, opts) => {
    const t0 = Date.now();
    const r = await listProcesses({ timeoutMs: 30000, ...opts });
    console.log(`DIAG ${label}: ${Date.now() - t0} ms, ${r.list ? r.list.length + ' processes' : JSON.stringify(r)}`);
    return r.list || [];
  };
  const cim = await t('CIM, full env', {});
  const wmiFull = await t('WMI, full env', { script: WMI_LIST });
  const wmiBase = await t('WMI, base env', { env: base, script: WMI_LIST });
  await t('WMI, base env again', { env: base, script: WMI_LIST });
  const key = (p) => `${p.pid}|${p.ppid}|${p.start}|${p.name}`;
  const a = new Set(cim.map(key));
  const same = wmiBase.filter((p) => a.has(key(p))).length;
  console.log(`DIAG same lines CIM vs WMI(base): ${same} of ${wmiBase.length} (CIM ${cim.length}, WMI full ${wmiFull.length})`);
  console.log('DIAG sample CIM', cim.slice(0, 3).map(key).join(' / '));
  console.log('DIAG sample WMI', wmiBase.slice(0, 3).map(key).join(' / '));
  const me = wmiBase.find((p) => p.pid === process.pid);
  console.log('DIAG me', me && key(me));
  const t0 = Date.now();
  const own = await ownChain({ installed: false });
  console.log(`DIAG ownChain: ${Date.now() - t0} ms`, JSON.stringify(own).slice(0, 600));
});
