const axios = require('axios');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'pharmcoder-kr';
const REPO = 'prescription_printer_parsing';
const VERSION = '1.2.1';
const TAG = `v${VERSION}`;

async function createRelease() {
  if (!GITHUB_TOKEN) {
    console.error('❌ GitHub Token이 필요합니다!');
    console.error('환경 변수 GH_TOKEN 또는 GITHUB_TOKEN을 설정해주세요.');
    process.exit(1);
  }

  const releaseNotes = `## v1.2.1: 시럽 단일약 봉투 파싱 지원

### 주요 변경사항
- **stacked_compact 파서 추가**: 약품명과 용법(535 등)이 여러 줄로 나뉜 FastReport 시럽 단일약 봉투 파싱
- 약품명 줄바꿈·\`*\` 접두사·3자리 압축 용법(예: 535 = 5mL/3회/5일) 자동 처리
- 양식 학습 v3에 stacked_compact 구조 자동 감지 추가

### 해결된 문제
- \`Fast Report Document_...pdf\` 형식에서 환자명만 읽히고 약물 0개로 실패하던 문제
- 「양식 분석 결과가 불완전합니다」 오류 (약물 0개)

### 설치 방법
아래의 \`auto-syrup-pdf-setup-${VERSION}.exe\` 파일을 다운로드하여 실행하세요.

### 업데이트
v1.2.0 이하 사용자는 프로그램 실행 시 자동 업데이트 알림을 받을 수 있습니다.`;

  const filesToUpload = [
    {
      path: `release/auto-syrup-pdf-setup-${VERSION}.exe`,
      name: `auto-syrup-pdf-setup-${VERSION}.exe`,
      contentType: 'application/x-msdownload'
    },
    {
      path: `release/auto-syrup-pdf-setup-${VERSION}.exe.blockmap`,
      name: `auto-syrup-pdf-setup-${VERSION}.exe.blockmap`,
      contentType: 'application/octet-stream'
    },
    {
      path: 'release/latest.yml',
      name: 'latest.yml',
      contentType: 'text/yaml'
    }
  ];

  try {
    console.log('===========================================');
    console.log('📦 GitHub Release 생성 시작');
    console.log('===========================================');
    console.log(`Repository: ${OWNER}/${REPO}`);
    console.log(`Version: ${VERSION}`);
    console.log(`Tag: ${TAG}`);
    console.log('');

    console.log('1️⃣  Release 생성 중...');
    let releaseResponse;
    let releaseId;
    let uploadUrl;

    try {
      releaseResponse = await axios.post(
        `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
        {
          tag_name: TAG,
          name: `v${VERSION} - 시럽 단일약 봉투 파싱 지원`,
          body: releaseNotes,
          draft: false,
          prerelease: false
        },
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );
      releaseId = releaseResponse.data.id;
      uploadUrl = releaseResponse.data.upload_url.replace('{?name,label}', '');
      console.log(`✅ Release 생성 완료 (ID: ${releaseId})`);
    } catch (error) {
      if (error.response?.status === 422) {
        console.log('ℹ️  기존 Release가 있어 업데이트합니다...');
        const existingReleases = await axios.get(
          `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              Accept: 'application/vnd.github.v3+json'
            }
          }
        );
        const existing = existingReleases.data.find((release) => release.tag_name === TAG);
        if (!existing) throw error;

        releaseResponse = await axios.patch(
          `https://api.github.com/repos/${OWNER}/${REPO}/releases/${existing.id}`,
          {
            name: `v${VERSION} - 시럽 단일약 봉투 파싱 지원`,
            body: releaseNotes,
            draft: false,
            prerelease: false
          },
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              Accept: 'application/vnd.github.v3+json'
            }
          }
        );
        releaseId = existing.id;
        uploadUrl = existing.upload_url.replace('{?name,label}', '');
        console.log(`✅ Release 업데이트 완료 (ID: ${releaseId})`);
      } else {
        throw error;
      }
    }

    console.log('');
    console.log('2️⃣  기존 에셋 확인 중...');
    try {
      const assetsResponse = await axios.get(
        `https://api.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`,
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
          }
        }
      );

      for (const asset of assetsResponse.data) {
        const shouldDelete = filesToUpload.some((file) => file.name === asset.name);
        if (shouldDelete) {
          console.log(`   삭제 중: ${asset.name}`);
          await axios.delete(
            `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`,
            {
              headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
              }
            }
          );
        }
      }
    } catch (error) {
      console.log('   기존 에셋 확인 중 오류 (무시하고 계속):', error.message);
    }

    console.log('');
    console.log('3️⃣  파일 업로드 중...');
    for (const file of filesToUpload) {
      if (!fs.existsSync(file.path)) {
        console.log(`⚠️  파일 없음: ${file.path}`);
        continue;
      }

      const fileData = fs.readFileSync(file.path);
      const fileSize = fs.statSync(file.path).size;
      const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

      console.log(`   업로드: ${file.name} (${fileSizeMB} MB)`);
      await axios.post(
        `${uploadUrl}?name=${encodeURIComponent(file.name)}`,
        fileData,
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            'Content-Type': file.contentType,
            'Content-Length': fileSize
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
      console.log(`   ✅ 업로드 완료: ${file.name}`);
    }

    console.log('');
    console.log('===========================================');
    console.log('✅ Release 생성 완료!');
    console.log('===========================================');
    console.log(`🔗 ${releaseResponse.data.html_url}`);
  } catch (error) {
    console.error('');
    console.error('❌ Release 생성 실패:', error.message);
    if (error.response) {
      console.error('상태 코드:', error.response.status);
      console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

createRelease();
