/**
 * services/git-input.js — validate user-supplied git inputs before they reach
 * child_process. Callers must still use execFile/spawn with an argv array;
 * these functions only guarantee the value is a plain ref / plain GitHub URL.
 */

// git ref name: letters, digits, . _ - and single slashes; no leading '-' or
// '.', no '..', no trailing '/', no whitespace or shell characters.
const BRANCH_RE = /^(?![.-])(?!.*\.\.)[A-Za-z0-9._-]+(?:\/(?![.-])[A-Za-z0-9._-]+)*$/;

// exactly https://github.com/<owner>/<repo>[.git], owner/repo = [A-Za-z0-9._-],
// not starting with '-' or '.', nothing after.
const GITHUB_RE = /^https:\/\/github\.com\/(?![.-])[A-Za-z0-9._-]+\/(?![.-])[A-Za-z0-9._-]+?(?:\.git)?$/;

function safeBranch(branch) {
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > 200) return null;
  return BRANCH_RE.test(branch) ? branch : null;
}

function safeGitHubUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return null;
  return GITHUB_RE.test(url) ? url : null;
}

module.exports = { safeBranch, safeGitHubUrl };
