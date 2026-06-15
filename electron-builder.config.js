const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');

// package.json의 build 설정을 기본으로 사용
const baseConfig = pkg.build || {};

module.exports = {
  ...baseConfig,
  
  // afterPack 훅 제거 - 빌드 중에는 EXE 파일이 잠겨있을 수 있음
  // 대신 빌드 후 npm run set-icon 명령으로 별도 실행
};

