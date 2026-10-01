// GPU student pods: the CUDA base image sets NVIDIA_VISIBLE_DEVICES=all, which
// makes the nvidia runtime inject EVERY GPU on the node regardless of the
// nvidia.com/gpu limit (a 1-GPU pod on Cerberus saw both 5090s). With the
// device plugin in CDI mode the allocated GPU arrives via CRI, so the env var
// must be neutralised with "void".
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPodSpec } = require('../services/k8s-containers');

const env = (spec) => Object.fromEntries((spec.spec.containers[0].env || []).map(e => [e.name, e.value]));

test('GPU pod sets NVIDIA_VISIBLE_DEVICES=void so only the allocated GPU is visible', () => {
  const spec = buildPodSpec('tuser', 't@newpaltz.edu', { target_node: 'cerberus', gpu_count: 1, preset: 'gpu_training' });
  assert.equal(spec.spec.runtimeClassName, 'nvidia');
  assert.equal(spec.spec.containers[0].resources.limits['nvidia.com/gpu'], '1');
  assert.equal(env(spec).NVIDIA_VISIBLE_DEVICES, 'void');
});

test('non-GPU pod does not set NVIDIA_VISIBLE_DEVICES', () => {
  const spec = buildPodSpec('tuser', 't@newpaltz.edu', { target_node: 'hydra', gpu_count: 0 });
  assert.equal(env(spec).NVIDIA_VISIBLE_DEVICES, undefined);
});

// NFS-backed homes: kubelet chowns every file for fsGroup on each start and
// times out after 2 min on large homes (vanderbd1 on Cerberus never started).
// OnRootMismatch skips the walk when the volume root already has the right group.
test('pod uses fsGroupChangePolicy OnRootMismatch so large NFS homes mount fast', () => {
  const spec = buildPodSpec('tuser', 't@newpaltz.edu', { target_node: 'cerberus', gpu_count: 0 });
  assert.equal(spec.spec.securityContext.fsGroup, 1000);
  assert.equal(spec.spec.securityContext.fsGroupChangePolicy, 'OnRootMismatch');
});
