# Third-party components

The vendored files are unmodified distributions. `scripts/vendor.mjs` copies
these files from the exact npm versions in `package-lock.json`.

| Component         | Version | License     | Upstream source                        |
| ----------------- | ------- | ----------- | -------------------------------------- |
| Mediabunny        | 1.61.6  | MPL-2.0     | https://github.com/Vanilagy/mediabunny |
| fflate            | 0.8.3   | MIT         | https://github.com/101arrowz/fflate    |
| Doto / Fontsource | 5.3.0   | SIL OFL-1.1 | https://github.com/oliverlalan/Doto    |

License texts are included in `dist/vendor/`. Mediabunny source for the
vendored release is also available in the published
[npm package](https://www.npmjs.com/package/mediabunny/v/1.61.6).

Lucide icons are copied from `lucide-static` **1.59.0**, ISC license.
Upstream: https://github.com/lucide-icons/lucide. License: `dist/vendor/lucide.LICENSE`.
