/**
 * The bundle is applied through its `dsh.bundle.patch` (cordis.patch.yml),
 * never as a composition row. This entry only exists so the package exports
 * "." for tooling and profile resolution.
 */

export const name = 'file-mention'

export function apply(): void {}
