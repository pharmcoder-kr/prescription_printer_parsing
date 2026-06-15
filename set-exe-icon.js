const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 빌드 후 별도로 실행하는 스크립트
// EXE 파일에 아이콘을 설정합니다

const exePath = path.join(__dirname, 'release', 'win-unpacked', '오토시럽.exe');
const iconPath = path.resolve(__dirname, 'build', 'icon.ico');

if (!fs.existsSync(exePath)) {
  console.error(`❌ EXE 파일을 찾을 수 없습니다: ${exePath}`);
  process.exit(1);
}

if (!fs.existsSync(iconPath)) {
  console.error(`❌ 아이콘 파일을 찾을 수 없습니다: ${iconPath}`);
  process.exit(1);
}

// rcedit 경로 찾기
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
const rceditPath = path.join(
  localAppData,
  'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0', 'rcedit-x64.exe'
);

if (!fs.existsSync(rceditPath)) {
  console.error(`❌ rcedit를 찾을 수 없습니다: ${rceditPath}`);
  process.exit(1);
}

try {
  console.log('🔧 EXE 파일에 아이콘 설정 중...');
  console.log(`   EXE: ${exePath}`);
  console.log(`   아이콘: ${iconPath}`);
  
  // EXE 파일이 잠겨있을 수 있으므로 잠시 대기
  console.log('   파일 잠금 해제 대기 중...');
  
  // rcedit 실행
  const command = `"${rceditPath}" "${exePath}" --set-icon "${iconPath}"`;
  
  console.log(`   실행 명령: ${command}`);
  
  execSync(command, { 
    stdio: 'inherit',
    cwd: path.dirname(exePath),
    timeout: 30000
  });
  
  console.log('✅ 아이콘 설정 완료');
  
  // Windows 아이콘 캐시 갱신
  try {
    console.log('🔄 Windows 아이콘 캐시 갱신 중...');
    execSync('ie4uinit.exe -show', { stdio: 'ignore' });
    console.log('✅ 아이콘 캐시 갱신 완료');
  } catch (cacheError) {
    console.log('⚠️ 아이콘 캐시 갱신 실패 (무시 가능)');
  }
  
  console.log('\n💡 파일 탐색기에서 F5를 눌러 새로고침하거나, 파일 탐색기를 다시 열어보세요.');
  
} catch (error) {
  console.error('❌ 아이콘 설정 실패:', error.message);
  if (error.stdout) console.error('stdout:', error.stdout.toString());
  if (error.stderr) console.error('stderr:', error.stderr.toString());
  process.exit(1);
}


