// Static image import typings (*.png, *.jpg, *.svg, ...).
//
// Next normally provides these via `next-env.d.ts`, but that file is generated
// by `next dev` / `next build` and is gitignored, so it is absent in CI when
// the `tsc --noEmit` step runs before the build. Referencing Next's image
// types here keeps `import img from '@/assets/foo.png'` typed in every
// environment. This is idempotent with `next-env.d.ts` (the same declaration
// file is included once), so it is safe locally too.
/// <reference types="next/image-types/global" />
