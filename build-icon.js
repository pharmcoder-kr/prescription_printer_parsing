const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// electron-builder의 afterPack 훅에서 실행되는 스크립트
// EXE 파일에 아이콘을 포함시키기 위해 rcedit를 사용

const platform = process.platform;
const arch = process.arch;

if (platform === 'win32') {
  const appOutDir = process.env.appOutDir || path.join(__dirname, 'release', 'win-unpacked');
  const exePath = path.join(appOutDir, '오토시럽.exe');
  const iconPath = path.resolve(__dirname, 'build', 'icon.ico');
  
  // 파일 존재 확인
  if (!fs.existsSync(exePath)) {
    console.log(`⚠️ EXE 파일을 찾을 수 없습니다: ${exePath}`);
    process.exit(0);
  }
  
  if (!fs.existsSync(iconPath)) {
    console.log(`⚠️ 아이콘 파일을 찾을 수 없습니다: ${iconPath}`);
    process.exit(0);
  }
  
  // rcedit 경로 찾기
  const rceditPath = path.join(
    process.env.LOCALAPPDATA || process.env.USERPROFILE,
    'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe'
  );
  
  if (!fs.existsSync(rceditPath)) {
    console.log(`⚠️ rcedit를 찾을 수 없습니다: ${rceditPath}`);
    console.log('아이콘 설정을 건너뜁니다.');
    process.exit(0);
  }
  
  try {
    console.log('🔧 EXE 파일에 아이콘 설정 중...');
    console.log(`   EXE: ${exePath}`);
    console.log(`   아이콘: ${iconPath}`);
    
    // rcedit 실행
    execSync(
      `"${rceditPath}" "${exePath}" --set-icon "${iconPath}"`,
      { stdio: 'inherit' }
    );
    
    console.log('✅ 아이콘 설정 완료');
  } catch (error) {
    console.error('❌ 아이콘 설정 실패:', error.message);
    // 오류가 발생해도 빌드는 계속 진행
    process.exit(0);
  }
} else {
  console.log('Windows가 아니므로 아이콘 설정을 건너뜁니다.');
  process.exit(0);
}


