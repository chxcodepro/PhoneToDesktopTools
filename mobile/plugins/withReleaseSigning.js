// 正式签名：release 包用你自己的签名证书，证书和密码只从环境变量读取（构建时），不写进任何文件。
//   P2D_KEYSTORE_FILE      证书文件（.jks / .keystore）的绝对路径
//   P2D_KEYSTORE_PASSWORD  证书库密码
//   P2D_KEY_ALIAS          密钥别名
//   P2D_KEY_PASSWORD       密钥密码
// 没设置 P2D_KEYSTORE_FILE 时仍用调试签名（和以前一样）。
// android/ 由 expo prebuild 生成、不入库，所以签名配置要通过这个插件写进 app/build.gradle。
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// p2d-release-signing';

const RELEASE_SIGNING = `
        release { ${MARK}
            if (System.getenv('P2D_KEYSTORE_FILE')) {
                storeFile file(System.getenv('P2D_KEYSTORE_FILE'))
                storePassword System.getenv('P2D_KEYSTORE_PASSWORD')
                keyAlias System.getenv('P2D_KEY_ALIAS')
                keyPassword System.getenv('P2D_KEY_PASSWORD')
            }
        }`;

const USE_RELEASE = `signingConfig System.getenv('P2D_KEYSTORE_FILE') ? signingConfigs.release : signingConfigs.debug ${MARK}`;

function apply(gradle) {
  if (gradle.includes(MARK)) return gradle;
  // signingConfigs { debug { ... } } 后面加 release
  const sc = gradle.match(/signingConfigs\s*\{\s*\n\s*debug\s*\{[^}]*\}/);
  if (!sc) throw new Error('withReleaseSigning：没有找到 signingConfigs.debug，模板可能变了');
  gradle = gradle.replace(sc[0], sc[0] + RELEASE_SIGNING);
  // buildTypes.release 里的 signingConfig 换成按环境变量选择
  const bt = gradle.match(/buildTypes\s*\{[\s\S]*?\n\s*release\s*\{[\s\S]*?signingConfig signingConfigs\.debug/);
  if (!bt) throw new Error('withReleaseSigning：没有找到 buildTypes.release 的 signingConfig，模板可能变了');
  gradle = gradle.replace(bt[0], bt[0].replace(/signingConfig signingConfigs\.debug$/, USE_RELEASE));
  return gradle;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = apply(c.modResults.contents);
    return c;
  });
};
module.exports.apply = apply;
