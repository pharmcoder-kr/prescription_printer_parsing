const axios = require('axios');

const GITHUB_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'pharmcoder-kr';
const REPO = 'prescription';
const TAG = 'v1.3.24';

async function deleteRelease() {
  if (!GITHUB_TOKEN) {
    console.error('❌ GitHub Token이 필요합니다!');
    process.exit(1);
  }

  try {
    console.log('===========================================');
    console.log('🗑️  GitHub Release 삭제');
    console.log('===========================================');
    
    // 1. 기존 Release 정보 가져오기
    console.log('1️⃣  기존 Release 정보 가져오기...');
    const releasesResponse = await axios.get(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    // 드래프트 릴리즈도 포함하여 찾기
    let release = releasesResponse.data.find(r => r.tag_name === TAG);
    
    // 드래프트 릴리즈가 있으면 그것을 사용
    if (!release) {
      release = releasesResponse.data.find(r => r.draft === true && r.tag_name === TAG);
    }
    
    // 태그가 없지만 이름에 버전이 있는 경우도 확인
    if (!release) {
      release = releasesResponse.data.find(r => r.name && r.name.includes('1.3.24'));
    }
    
    if (!release) {
      console.log(`❌ ${TAG} 릴리즈를 찾을 수 없습니다.`);
      return;
    }
    
    console.log(`✅ Release 발견 (ID: ${release.id})`);
    console.log(`   제목: ${release.name}`);
    console.log(`   첨부 파일: ${release.assets.length}개`);
    
    // 2. Release 삭제
    console.log('2️⃣  Release 삭제 중...');
    await axios.delete(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    console.log('✅ Release 삭제 완료');
    
    // 3. 태그도 삭제
    console.log('3️⃣  태그 삭제 중...');
    await axios.delete(
      `https://api.github.com/repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    console.log('✅ 태그 삭제 완료');
    console.log('');
    console.log('===========================================');
    console.log('✅ 삭제 완료!');
    console.log('===========================================');
    console.log('');
    console.log('💡 이제 새로운 Release를 만들 수 있습니다.');
    console.log('');
    
  } catch (error) {
    console.error('');
    console.error('❌ 삭제 실패:', error.message);
    if (error.response) {
      console.error('상태 코드:', error.response.status);
      console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

deleteRelease();

