// /api/servers/status: a node is ONLINE/OFFLINE according to Kubernetes node
// readiness, not according to whether its metrics agent answered. Cerberus
// showed OFFLINE on /servers whenever its agent timed out although the node
// was Ready and running pods.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DISABLED_NODES = '';
const router = require('../routes/servers-api');

test('Ready node with failed/missing metrics is online; NotReady node is offline', async () => {
  router._readinessProvider = async () => ({ hydra: true, chimera: false, cerberus: true });
  const out = await router.formatCollectedMetrics({
    hydra: null,
    chimera: { status: 'online', system: {} },      // agent cached data but node is NotReady
    cerberus: { status: 'offline' },                 // agent timed out but node is Ready
    lastUpdated: new Date().toISOString(),
  });
  assert.equal(out.cerberus.status, 'online');
  assert.deepEqual(out.cerberus.gpus, []);
  assert.equal(out.chimera.status, 'offline');
  assert.equal(out.hydra.status, 'online');         // entry synthesised so the page still renders it
});

test('unknown readiness keeps the agent-reported status', async () => {
  router._readinessProvider = async () => null;
  const out = await router.formatCollectedMetrics({ cerberus: { status: 'offline' }, lastUpdated: 'x' });
  assert.equal(out.cerberus.status, 'offline');
});
