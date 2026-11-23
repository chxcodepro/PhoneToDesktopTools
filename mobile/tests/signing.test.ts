// 正式签名插件：把按环境变量选择签名证书的配置写进 app/build.gradle
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { apply } = require('../plugins/withReleaseSigning.js') as { apply: (s: string) => string };

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution!
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

test('release 包按环境变量选择签名证书，debug 包不变', () => {
  const out = apply(TEMPLATE);
  assert.match(out, /release \{ \/\/ p2d-release-signing\n\s+if \(System\.getenv\('P2D_KEYSTORE_FILE'\)\)/);
  assert.match(out, /signingConfig System\.getenv\('P2D_KEYSTORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug/);
  // debug 构建类型仍用调试签名
  assert.match(out, /debug \{\n\s+signingConfig signingConfigs\.debug\n/);
  // 不写死任何密码
  assert.doesNotMatch(out.slice(out.indexOf('release {')), /storePassword '/);
});

test('重复执行不会再插入', () => {
  const once = apply(TEMPLATE);
  assert.equal(apply(once), once);
});

test('模板变了时报错，而不是悄悄用调试签名', () => {
  assert.throws(() => apply('android { }'));
});
