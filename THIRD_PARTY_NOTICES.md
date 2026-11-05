# Third-party notices

This package redistributes a built **WeKnora Lite** server, which is not part of the
plugin's own source code.

## WeKnora

- Project: https://github.com/Tencent/WeKnora
- Version: 0.9.0 (Lite edition)
- License: MIT, plus the third-party component licenses listed in its notices file
- Copyright (C) 2026 Tencent. All rights reserved.

The complete license text ships inside the platform asset directory:

- `assets/win32-x64/LICENSE`
- `assets/win32-x64/THIRD_PARTY_NOTICES.md`
- `assets/win32-x64/licenses/`

Redistribution keeps those files verbatim at runtime as well: the supervisor stages
the asset directory's contents next to the server, and the license files are never
modified.

## What is bundled versus generated

- Bundled (read only): the server executable, the built web UI, the default config
  tree, the SQLite migrations, and the license files above.
- Generated at first run under `$DSH_HOME/weknora`: the SQLite database, uploaded
  files, logs, and a dotenv file containing locally generated secrets. Nothing from
  the upstream distribution is written to `node_modules`.