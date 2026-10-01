// DISABLED_NODES=chimera,... hides a node everywhere (dashboard, /servers,
// resource requests, metrics) without deleting its config, so it can come
// back by clearing the env var. Chimera is down as of 2026-09-15.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DISABLED_NODES = ' Chimera ,';
const cfg = require('../config/resources');

test('disabled node is flagged and excluded from enabledNodeNames()', () => {
  assert.equal(cfg.nodes.chimera.disabled, true);
  assert.equal(cfg.nodes.cerberus.disabled, undefined);
  assert.deepEqual(cfg.enabledNodeNames(), ['hydra', 'cerberus']);
  assert.equal(cfg.isNodeEnabled('chimera'), false);
  assert.equal(cfg.isNodeEnabled('cerberus'), true);
  assert.equal(cfg.isNodeEnabled('nope'), false);
  assert.deepEqual(cfg.disabledNodeNames(), ['chimera']);
});

test('presets that can only run on a disabled node are unavailable', () => {
  assert.equal(cfg.isPresetAvailable('gpu_inference'), false);
  assert.equal(cfg.isPresetAvailable('gpu_training'), true);
  assert.equal(cfg.isPresetAvailable('standard'), true);
  assert.ok(!cfg.getPresetsForNode('chimera').length);
});
