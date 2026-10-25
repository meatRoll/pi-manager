import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageDisplayName } from '../src/package-label.js';

test('Git labels follow the configured fork, not the upstream manifest name', () => {
  for (const source of [
    'git:github.com/meatRoll/pi-image-gen',
    'git:https://github.com/meatRoll/pi-image-gen',
    'https://github.com/meatRoll/pi-image-gen.git',
    'git:github.com/meatRoll/pi-image-gen@v1.0.0',
    'https://github.com/meatRoll/pi-image-gen.git@feature/labels',
    'https://github.com/meatRoll/pi-image-gen#main',
    'ssh://git@github.com/meatRoll/pi-image-gen.git',
    'git:git@github.com:meatRoll/pi-image-gen.git@main',
    'git@github.com:meatRoll/pi-image-gen.git',
    'git+https://github.com/meatRoll/pi-image-gen.git',
    'git+ssh://git@github.com/meatRoll/pi-image-gen.git',
    'git://github.com/meatRoll/pi-image-gen.git',
    'git:github:meatRoll/pi-image-gen',
    'git:meatRoll/pi-image-gen',
    'git:meatRoll/pi-image-gen@feature/labels',
    'git:meatRoll/pi-image-gen.git#feature/labels',
  ]) assert.equal(packageDisplayName(source, '@ssweens/pi-image-gen'), 'meatRoll/pi-image-gen', source);
  assert.equal(packageDisplayName('git:https://github.com/meatRoll/pi-repo-model', '@tian.zuo/pi-repo-model'), 'meatRoll/pi-repo-model');
  assert.equal(packageDisplayName('https://user:password@github.com/meatRoll/pi-repo-model.git/'), 'meatRoll/pi-repo-model');
});

test('Git labels retain non-GitHub hosts and nested groups without ref/version noise', () => {
  for (const [source, expected] of [
    ['git:gitlab.com/acme/team/extension.git@feature/labels', 'gitlab.com/acme/team/extension'],
    ['https://git.example.com/acme/extension.git#v1', 'git.example.com/acme/extension'],
    ['git:git@private.example:acme/extension.git', 'private.example/acme/extension'],
    ['ssh://git@git.example.com:2222/acme/extension.git', 'git.example.com:2222/acme/extension'],
    ['git:gitlab:acme/extension', 'gitlab.com/acme/extension'],
    ['git:bitbucket:acme/extension', 'bitbucket.org/acme/extension'],
  ]) assert.equal(packageDisplayName(source, '@upstream/extension'), expected, source);
});

test('npm labels use the configured package name; local labels preserve manifest and path fallback', () => {
  for (const [source, expected] of [
    ['npm:@meatroll/pi-tools@1.2.3', '@meatroll/pi-tools'],
    ['npm:@meatroll/pi-tools', '@meatroll/pi-tools'],
    ['npm:pi-tools@latest', 'pi-tools'],
    ['npm:pi-tools@^1', 'pi-tools'],
  ]) assert.equal(packageDisplayName(source, '@other/name'), expected);
  assert.equal(packageDisplayName('/tmp/pi-todos', 'pi-todos'), 'pi-todos');
  assert.equal(packageDisplayName('./local-tools', '@local/tools'), '@local/tools');
  assert.equal(packageDisplayName('/tmp/unnamed-package'), '/tmp/unnamed-package');
  assert.equal(packageDisplayName('file:///tmp/unnamed-package', 'local-package'), 'local-package');
});

test('local checkouts use their own Git origin; configured remote sources still take precedence', () => {
  assert.equal(packageDisplayName('/tmp/pi-todos', 'pi-todos', 'https://github.com/meatRoll/pi-todos.git'), 'meatRoll/pi-todos');
  assert.equal(packageDisplayName('./checkout', '@upstream/tools', 'git@github.com:meatRoll/tools.git'), 'meatRoll/tools');
  assert.equal(packageDisplayName('./checkout', 'tools', 'ssh://git@git.example.com/acme/tools.git'), 'git.example.com/acme/tools');
  for (const origin of [undefined, '', '/tmp/other-checkout', 'not-a-repository', 'https://[invalid', 'npm:other']) {
    assert.equal(packageDisplayName('./checkout', '@local/tools', origin), '@local/tools');
    assert.equal(packageDisplayName('./checkout', undefined, origin), './checkout');
  }
  assert.equal(packageDisplayName('npm:tools@1.2.3', 'tools', 'https://github.com/other/tools'), 'tools');
  assert.equal(packageDisplayName('git:github.com/meatRoll/tools', '@upstream/tools', 'https://github.com/other/tools'), 'meatRoll/tools');
});

test('unparsed Git sources fall back to the configured source instead of misleading upstream metadata', () => {
  for (const source of ['git:not-a-repository', 'git:https://github.com/owner', 'https://[invalid', 'git:github.com/owner/../repo']) {
    assert.equal(packageDisplayName(source, '@upstream/wrong-name'), source);
  }
});
