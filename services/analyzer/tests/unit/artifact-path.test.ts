import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactPathError, resolveArtifactPath } from '../../src/security/artifact-path.js';

const root = path.join(os.tmpdir(), 'pitchtrace-artifact-root');

await test('kök içindeki relative yollar çözülür', () => {
  const resolved = resolveArtifactPath(root, 'screenshots/abc/def.png');
  assert.equal(resolved, path.resolve(root, 'screenshots/abc/def.png'));
});

await test('kök dışına çıkan yollar reddedilir', () => {
  for (const bad of [
    '../etc/passwd',
    'screenshots/../../secret.txt',
    './../../../../etc/shadow',
  ]) {
    assert.throws(() => resolveArtifactPath(root, bad), ArtifactPathError, bad);
  }
});

await test('mutlak yollar reddedilir', () => {
  for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', '/data/x.png']) {
    assert.throws(() => resolveArtifactPath(root, bad), ArtifactPathError, bad);
  }
});

await test('NUL içeren yollar reddedilir', () => {
  assert.throws(() => resolveArtifactPath(root, 'a\0b.png'), ArtifactPathError);
});
