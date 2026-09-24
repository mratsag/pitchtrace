import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewRefreshHandle, createPreviewToken, verifyPreviewRefreshHandle, verifyPreviewToken } from '../../src/security/preview-token.js';

describe('preview token', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  it('is artifact-bound and expires', () => {
    const made = createPreviewToken(id, 1_000_000);
    assert.deepEqual(verifyPreviewToken(made.token, 1_001_000), { artifactId: id });
    assert.equal(verifyPreviewToken(made.token, Date.parse(made.expiresAt)), null);
  });
  it('rejects tampering and malformed/path-like input', () => {
    const { token } = createPreviewToken(id);
    const [payload, signature] = token.split('.');
    const changed = `${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    assert.equal(verifyPreviewToken(changed), null);
    assert.equal(verifyPreviewToken('../../etc/passwd'), null);
    assert.equal(verifyPreviewToken('https://example.invalid/a'), null);
    assert.equal(verifyPreviewToken(''), null);
  });
  it('refresh handle is separately scoped and cannot be used as a preview token',()=>{
    const made=createPreviewRefreshHandle(id,1_000_000);
    assert.deepEqual(verifyPreviewRefreshHandle(made.handle,1_001_000),{artifactId:id});
    assert.equal(verifyPreviewToken(made.handle,1_001_000),null);
    assert.equal(verifyPreviewRefreshHandle(made.handle,Date.parse(made.expiresAt)),null);
  });
});
