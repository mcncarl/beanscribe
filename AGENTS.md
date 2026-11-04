# Development

- This repository is the shareable source distribution. Keep credentials, account identifiers, server addresses, recordings and diagnostics in ignored local directories.
- `preview.html`, `h5/`, `lib/`, `pages/index/index.js`, `ui-assets/` and `server/` are the deployed H5 product. TTML/TTSS and `app.*` are an experimental mini-app shell, not a verified native distribution.
- After changing bundled BLE modules, run `npm run build` and commit the regenerated `h5/d3200-bundle.js`.
- Run `npm test` for front-end changes, and `python -m unittest discover -s server -p 'test_*.py'` for server changes. Tests use mocks and synthetic audio; they must not call paid APIs or operate hardware.
- Full packaging validation: `python tools/check_release.py`; source completeness and remote Git hashes are separate from real phone acceptance.
- Do not implement a multi-user deployment by merely widening the login allowlist: recordings currently share one private store.
