// Rust 코어 wasm 을 쓰는 곳 세 군데에 한 번에 넣는다: web/vendor, worker/src/rust-core.js, apps-script/Code.gs 맨 끝.
// 먼저: cargo build --release --target wasm32-unknown-unknown (이 폴더에서). 그다음: node embed-wasm.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const built = path.join(__dirname, 'target/wasm32-unknown-unknown/release/gyecheuk_core.wasm');
const wasm = fs.readFileSync(built);
if (wasm.readUInt32BE(0) !== 0x0061736d) throw new Error('wasm 파일이 아닙니다');
const b64 = wasm.toString('base64');

const swap = (file, re, line) => {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, 'utf8');
  const hits = src.match(new RegExp(re.source, 'gm')) || [];
  if (hits.length > 1) throw new Error(`${file}: 바꿀 줄이 ${hits.length}개`);
  const next = hits.length ? src.replace(re, () => line) : `${src.replace(/\n*$/, '\n')}\n${line}\n`;
  fs.writeFileSync(p, next);
  console.log(`${file}: ${hits.length ? '바꿈' : '맨 끝에 붙임'}`);
};

fs.copyFileSync(built, path.join(root, 'web/vendor/gyecheuk_core.wasm'));
console.log(`web/vendor/gyecheuk_core.wasm: ${wasm.length} 바이트`);
swap('worker/src/rust-core.js', /^const WASM_B64 = '[A-Za-z0-9+/=]*';$/m, `const WASM_B64 = '${b64}';`);
swap('apps-script/Code.gs', /^const RUST_CORE_B64 = '[A-Za-z0-9+/=]*';.*$/m,
  `const RUST_CORE_B64 = '${b64}';   // web/android/rust-core 를 wasm 으로 빌드한 것. 손으로 고치지 말고 그 폴더의 embed-wasm.js 로 넣는다`);
