// POST /dashboard/api/infra/deploy/github used to build a shell string from
// repoUrl + branch. Inputs are now validated and passed as argv (no shell).
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeBranch, safeGitHubUrl } = require('../services/git-input');

test('safeBranch accepts normal refs', () => {
  for (const b of ['main', 'feature/x_1.2', 'release-2026.09', 'v1.0']) assert.equal(safeBranch(b), b);
});
test('safeBranch rejects shell metacharacters, options and traversal', () => {
  for (const b of ['main; rm -rf /', 'x`id`', '$(id)', '--upload-pack=/bin/sh', '-x', 'a b', '../x', 'a..b', 'x\n', 'x/', '.hidden', ''])
    assert.equal(safeBranch(b), null, `should reject ${JSON.stringify(b)}`);
});
test('safeGitHubUrl accepts owner/repo with or without .git, nothing else', () => {
  assert.equal(safeGitHubUrl('https://github.com/compsci-suny-newpaltz/ilcc'), 'https://github.com/compsci-suny-newpaltz/ilcc');
  assert.equal(safeGitHubUrl('https://github.com/a-b/c.d.git'), 'https://github.com/a-b/c.d.git');
  for (const u of ['https://github.com/a/b;id', 'https://github.com/a/b/../../x', 'https://github.com/a/b?x=1', 'https://github.com/a',
                   'https://github.com/a/b/c', 'http://github.com/a/b', 'https://github.com/-a/b', 'https://github.com/a/b ', 'https://github.com/a/b\n'])
    assert.equal(safeGitHubUrl(u), null, `should reject ${JSON.stringify(u)}`);
});
