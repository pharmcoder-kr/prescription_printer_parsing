const axios = require('axios');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'pharmcoder-kr';
const REPO = 'prescription_printer_parsing';
const VERSION = '1.2.2';
const TAG = `v${VERSION}`;

async function createRelease() {
  if (!GITHUB_TOKEN) {
    console.error('❌ GitHub Token이 필요합니다!');
    console.error('환경 변수 GH_TOKEN 또는 GITHUB_TOKEN을 설정해주세요.');
    process.exit(1);
  }

  const releaseNotes = `## v1.2.2: PDF 파싱 후 자동 삭제

### 주요 변경사항
- **파싱 후 PDF 자동 삭제 옵션**: 환경설정에서 활성화 시, 파싱에 성공한 PDF만 지정 폴더에서 자동 삭제
- 폴더에 PDF가 수천 개 쌓여 디스크·스캔 부담이 커지는 문제 방지
- 파싱 실패 파일은 삭제하지 않고 남겨 재시도·확인 가능

### 설정 방법
환경설정 → 약봉투 PDF 연동 → **「파싱 후 PDF 자동 삭제」** 체크

### 설치 방법
아래의 \`auto-syrup-pdf-setup-${VERSION}.exe\` 파일을 다운로드하여 실행하세요.

### 업데이트
v1.2.1 이하 사용자는 프로그램 실행 시 자동 업데이트 알림을 받을 수 있습니다.`;

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
          name: `v${VERSION} - PDF 파싱 후 자동 삭제`,
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
            name: `v${VERSION} - PDF 파싱 후 자동 삭제`,
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
