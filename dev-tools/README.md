# dev-tools (for the claude.ai Artifact version of campus-world.html)
jsdom harness that fakes `claude.use('db'|'room'|'user')` with a shared in-memory backend so several "accounts" can run in one Node process.
Setup: `npm i jsdom@24`, put the html next to it as `cw.html` (harness reads `process.argv[2]||'cw.html'`), then `node artifact-regression-test.js` (42 checks).
It is a FAKE runtime: it proves the page logic, not real claude.ai behaviour. Canvas is stubbed (no rendering test).
