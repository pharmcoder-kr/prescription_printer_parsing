const axios = require('axios');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'pharmcoder-kr';
const REPO = 'prescription_printer_parsing';
const VERSION = '1.2.3';
const TAG = `v${VERSION}`;

async function createRelease() {
  if (!GITHUB_TOKEN) {
    console.error('❌ GitHub Token이 필요합니다!');
    console.error('환경 변수 GH_TOKEN 또는 GITHUB_TOKEN을 설정해주세요.');
    process.exit(1);
  }

  const releaseNotes = `## v1.2.3: PM2000 약봉투 PDF 파싱 지원

### 주요 변경사항
- **PM2000 봉투출력 양식 파싱**: 헤더 아래 분절 약품명 + 숫자 행(투약량·일수·횟수) 구조 지원
- **환자명·접수번호**: 상단 중복 이름, \`(남/만 N세)\` 패턴 및 날짜+순번(\`20260615-00003\`) 자동 생성
- **시럽·츄정 compact 코드**: 본문 내 \`533\`, \`113\` 등 3~4자리 용량 코드 연동
- **자동 양식 학습**: \`matrix_after_header\` 유형으로 v3 범용 파서에 등록

### 설치 방법
아래의 \`auto-syrup-pdf-setup-${VERSION}.exe\` 파일을 다운로드하여 실행하세요.

### 업데이트
v1.2.2 이하 사용자는 프로그램 실행 시 자동 업데이트 알림을 받을 수 있습니다.`;

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
          name: `v${VERSION} - PM2000 약봉투 파싱`,
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
            name: `v${VERSION} - PM2000 약봉투 파싱`,
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
