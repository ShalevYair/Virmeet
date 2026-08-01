// Virmeet — GitHub Pages serves the site from a subpath (e.g. /Virmeet), not
// the domain root. Every fetch() for a public/ asset must go through this
// helper, or it will resolve against the domain root and 404 on the live site
// (see docs/PLAN-static-github-pages.md §2.3).

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Prefixes a path relative to `public/` with the app's basePath. */
export function seedUrl(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, '');
  return `${BASE_PATH}/${trimmed}`;
}
