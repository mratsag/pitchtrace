import fs from 'node:fs/promises';
import path from 'node:path';

export class ArtifactPathError extends Error {
  constructor(
    readonly code: 'PATH_TRAVERSAL',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/**
 * Relative bir artifact yolunu ARTIFACT_ROOT içine çözer.
 * Kök dışına çıkan her yol reddedilir (docs/design §2.7).
 */
export function resolveArtifactPath(root: string, relPath: string): string {
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new ArtifactPathError('PATH_TRAVERSAL', `absolute artifact path rejected: ${relPath}`);
  }
  if (relPath.includes('\0')) {
    throw new ArtifactPathError('PATH_TRAVERSAL', 'artifact path contains NUL');
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new ArtifactPathError('PATH_TRAVERSAL', `artifact path escapes root: ${relPath}`);
  }
  return target;
}

/** Symlink'ler dahil, gerçek yolun kök içinde kaldığını doğrular. */
export async function resolveArtifactPathReal(root: string, relPath: string): Promise<string> {
  const target = resolveArtifactPath(root, relPath);
  const rootReal = await fs.realpath(path.resolve(root));
  let targetReal: string;
  try {
    targetReal = await fs.realpath(target);
  } catch {
    // Dosya yoksa syntactic kontrol yeterlidir; çağıran ENOENT ile ilgilenir.
    return target;
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new ArtifactPathError('PATH_TRAVERSAL', `artifact realpath escapes root: ${relPath}`);
  }
  return targetReal;
}
