const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'pharmcoder-kr';
const REPO = 'ESP32-CODE';
const BRANCH = 'main';
const OTA_PATH = 'OTA'; // GitHub 저장소의 OTA 폴더(대문자, raw 경로와 일치)

async function uploadESP32Firmware() {
  if (!GITHUB_TOKEN) {
    console.error('❌ GitHub Token이 필요합니다!');
    console.error('환경 변수 GH_TOKEN 또는 GITHUB_TOKEN을 설정해주세요.');
    process.exit(1);
  }

  try {
    console.log('===========================================');
    console.log('📤 ESP32 펌웨어 GitHub 업로드');
    console.log('===========================================');
    console.log(`Repository: ${OWNER}/${REPO}`);
    console.log(`Branch: ${BRANCH}`);
    console.log(`Path: ${OTA_PATH}`);
    console.log('');

    // 1. version.txt 업로드
    console.log('1️⃣  version.txt 업로드...');
    const versionContent = fs.readFileSync('version.txt', 'utf8').trim();
    await uploadFile('version.txt', versionContent, 'text/plain');
    console.log('✅ version.txt 업로드 완료');

    // 2. firmware.bin 업로드
    console.log('2️⃣  firmware.bin 업로드...');
    if (!fs.existsSync('firmware.bin')) {
      console.error('❌ firmware.bin 파일을 찾을 수 없습니다!');
      console.error('Arduino IDE에서 ESP32 코드를 컴파일하여 firmware.bin 파일을 생성해주세요.');
      console.error('생성 위치: Arduino IDE의 스케치 폴더/.pio/build/esp32dev/firmware.bin');
      process.exit(1);
    }
    
    const firmwareContent = fs.readFileSync('firmware.bin');
    await uploadFile('firmware.bin', firmwareContent.toString('base64'), 'application/octet-stream', true);
    console.log('✅ firmware.bin 업로드 완료');

    console.log('');
    console.log('===========================================');
    console.log('✅ 모든 파일 업로드 완료!');
    console.log('===========================================');
    console.log(`버전: ${versionContent}`);
    console.log(`URL: https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${OTA_PATH}/version.txt`);
    console.log(`URL: https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${OTA_PATH}/firmware.bin`);

  } catch (error) {
    console.error('❌ 업로드 실패:', error.response?.data || error.message);
    process.exit(1);
  }
}

async function uploadFile(filename, content, contentType, isBinary = false) {
  const filePath = `${OTA_PATH}/${filename}`;
  
  // 기존 파일이 있는지 확인
  let sha = null;
  try {
    const getResponse = await axios.get(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    sha = getResponse.data.sha;
    console.log(`   기존 파일 발견 (SHA: ${sha.substring(0, 7)}...)`);
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
    console.log(`   새 파일 생성`);
  }

  // 파일 업로드
  const uploadData = {
    message: `Update ${filename} to version 1.0.1`,
    content: isBinary ? content : Buffer.from(content).toString('base64'),
    branch: BRANCH
  };

  if (sha) {
    uploadData.sha = sha;
  }

  await axios.put(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`,
    uploadData,
    {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }
  );
}

// 실행
uploadESP32Firmware();







