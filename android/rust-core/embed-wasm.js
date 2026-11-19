// Rust 코어 wasm 을 빌드해서 쓰는 곳 세 군데에 넣는다(이 폴더에서 node embed-wasm.js 하나만 돌리면 된다).
// 다 든 판(ai 기능 포함) → web/vendor, worker/src/rust-core.js
// 작은 판(--no-default-features: 잠금·복귀만) → apps-script/Code.gs 맨 끝. Code.gs 는 AI 창구를 안 써서 크기만 늘지 않게 뺀다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const build = (extra, dir) => {
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', ...extra], { cwd: __dirname, stdio: 'inherit' });
  const wasm = fs.readFileSync(path.join(__dirname, dir, 'wasm32-unknown-unknown/release/gyecheuk_core.wasm'));
  if (wasm.readUInt32BE(0) !== 0x0061736d) throw new Error('wasm 파일이 아닙니다');
  return wasm;
};
const full = build([], 'target');
const small = build(['--no-default-features', '--target-dir', 'target/small'], 'target/small');

const swap = (file, re, line) => {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.match(new RegExp(re.source, 'gm')) || [];
  if (hits.length > 1) throw new Error(`${file}: 바꿀 줄이 ${hits.length}개`);
  const next = hits.length ? src.replace(re, () => line) : `${src.replace(/\n*$/, '\n')}\n${line}\n`;
  fs.writeFileSync(p, next);
  console.log(`${file}: ${hits.length ? '바꿈' : '맨 끝에 붙임'}`);
};

fs.writeFileSync(path.join(root, 'web/vendor/gyecheuk_core.wasm'), full);
console.log(`web/vendor/gyecheuk_core.wasm: ${full.length} 바이트(다 든 판), Code.gs: ${small.length} 바이트(작은 판)`);
swap('worker/src/rust-core.js', /^const WASM_B64 = '[A-Za-z0-9+/=]*';$/m, `const WASM_B64 = '${full.toString('base64')}';`);
swap('apps-script/Code.gs', /^const RUST_CORE_B64 = '[A-Za-z0-9+/=]*';.*$/m,
  `const RUST_CORE_B64 = '${small.toString('base64')}';   // web/android/rust-core 를 wasm 으로 빌드한 것(작은 판). 손으로 고치지 말고 그 폴더의 embed-wasm.js 로 넣는다`);
