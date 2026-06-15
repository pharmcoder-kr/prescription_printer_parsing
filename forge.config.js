const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
  packagerConfig: {
    name: '오토시럽',
    executableName: '오토시럽',
    icon: path.resolve(__dirname, 'build', 'icon'), // 확장자 없이 (자동으로 .ico 추가)
    asar: true,
    out: path.resolve(__dirname, 'out'),
    extraResource: [
      path.resolve(__dirname, 'assets'),
      path.resolve(__dirname, 'build', 'icon.ico')
    ],
    ignore: [
      /^\/\.git\/.*$/,
      /^\/release\/.*$/,
      /^\/dist\/.*$/,
      /^\/out\/.*$/,
      /^\/\.vscode\/.*$/,
      /^\/electron-cache\/.*$/,
      // 불필요한 폴더 제외
      /^\/prescription\/.*$/,
      /^\/prescription-platform\/.*$/,
      /^\/backend\/.*$/,
      // build 폴더의 불필요한 파일 제외
      /^\/build\/.*\.(nsh|png)$/,
      // 루트의 불필요한 파일 제외
      /^\/.*\.(md|txt|bat|ps1|nsi|nsh|sql|yaml|yml|py|ino)$/,
      /^\/requirements\.txt$/,
      // 1.3.28 버전과 동일: 필수 모듈의 모든 의존성은 자동으로 포함
      // 개발 도구만 제외 (빌드 시에만 필요한 패키지)
      // 런타임에 필요한 모든 의존성(semver, lodash.get, builder-util-runtime 등)은 포함
      /^\/node_modules\/(@electron-forge|@electron\/forge|@types|webpack|electron-builder|electron-forge-maker-nsis|electron-packager|electron-winstaller|electron-wix-msi|@electron\/rebuild|@electron\/get|@electron\/packager|@electron\/notarize|@electron\/osx-sign|@electron\/universal|@electron\/windows-sign|galactus|flora-colossus|get-package-info|read-pkg-up|read-pkg|load-json-file|archiver|archiver-utils|zip-stream|temp-file|dmg-builder|electron-publish|electron-builder-squirrel-windows|@malept\/flatpak-bundler|sumchecker|read-binary-file-arch|make-fetch-happen|socks-proxy-agent|extract-zip|watchpack|enhanced-resolve).*$/
      // 각 모듈 내에서 불필요한 파일만 제외 (의존성 파일은 모두 포함)
    ]
  },
  rebuildConfig: {},
  makers: [
    // NSIS 설치 파일은 electron-builder로 별도 생성
    // electron-forge는 패키징만 수행
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'pharmcoder-kr',
          name: 'prescription'
        },
        prerelease: false
      }
    }
  ]
};

