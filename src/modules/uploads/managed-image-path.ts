const managedImagePathPattern = /^uploads\/[a-f0-9]{16}\.(?:jpg|png|gif|webp)$/;

/**
 * Portable PHP-compatible managed image identity. The flat lowercase shape is
 * deliberately narrower than a filesystem path so callers cannot admit
 * traversal, nested names, alternate spellings, or unowned public files.
 */
export function isManagedImagePath(value: string): boolean {
  return managedImagePathPattern.test(value);
}

export function isManagedImageRequestPath(pathname: string): boolean {
  return pathname.startsWith("/") && isManagedImagePath(pathname.slice(1));
}

export function managedImageFilename(value: string): string | null {
  return isManagedImagePath(value) ? value.slice("uploads/".length) : null;
}
