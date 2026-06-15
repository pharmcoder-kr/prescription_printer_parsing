# GitHub 드래프트 릴리즈 생성 스크립트
param(
    [string]$Token = $env:GITHUB_TOKEN,
    [string]$Tag = "v1.3.26",
    [string]$Repo = "pharmcoder-kr/prescription"
)

if (-not $Token) {
    Write-Host "GitHub Personal Access Token이 필요합니다." -ForegroundColor Yellow
    Write-Host "다음 중 하나를 선택하세요:" -ForegroundColor Yellow
    Write-Host "1. 환경 변수 GITHUB_TOKEN 설정" -ForegroundColor Yellow
    Write-Host "2. 스크립트 실행 시 -Token 매개변수로 전달" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "예: .\create_draft_release_v1.3.26.ps1 -Token 'your_token_here'" -ForegroundColor Cyan
    exit 1
}

$releaseBody = @"
## v1.3.26: 자동조제 화면 개선 및 연결 상태 관리 개선

### 주요 변경사항
- **자동조제 화면에 연결된 시럽조제기 상태 표시**: 자동조제 화면 상단에 간소화된 연결된 시럽조제기 상태를 실시간으로 확인 가능
- **'시럽 조제 중' 상태 제거**: ESP32 듀얼코어 특성상 조제 중에도 통신이 가능하므로 불필요한 상태 제거
- **연결 상태 복구 로직 개선**: 일시적 응답 없음 상태에서 정상 응답 시 즉시 연결됨 상태로 복구
- **일괄연결 버튼 추가**: 자동조제 화면에서도 등록된 모든 기기를 한 번에 연결 가능

### 수정 내용

#### 자동조제 화면 개선
- 자동조제 화면 상단에 연결된 시럽조제기 상태 카드 추가
- 약품명, 약품코드, IP 주소, 상태를 간소화된 형태로 표시
- 여러 기기가 연결되어 있어도 스크롤로 확인 가능
- 일괄연결 버튼 추가로 설정 페이지로 이동 없이 바로 연결 가능

#### 연결 상태 관리 개선
- '시럽 조제 중' 상태 완전 제거
- 조제 중에도 기기 상태는 '연결됨'으로 유지 (ESP32 듀얼코어로 통신 가능)
- 조제 시작/완료 시 불필요한 상태 변경 제거
- 조제 중인 기기는 dispensingDevices Set에만 추가하여 참고용으로만 사용

#### 연결 상태 복구 로직 개선
- 200 응답 시 MAC 정보 유무와 관계없이 '연결됨' 상태로 복구
- 이전에는 MAC 정보가 없으면 '일시적 응답 없음'으로 유지되던 문제 해결
- 실제 연결 상태를 더 정확하게 반영

### 기술적 세부사항
- **기존**: 조제 시작 시 '시럽 조제 중' 상태로 변경 → 조제 완료 시 '연결됨'으로 복구
- **수정**: 조제 중에도 '연결됨' 상태 유지 (ESP32 듀얼코어 특성 활용)
- **기존**: MAC 정보 없으면 '일시적 응답 없음' 유지
- **수정**: 200 응답이면 MAC 정보 유무와 관계없이 '연결됨'으로 복구

### 해결된 문제
- 자동조제 화면에서 연결된 시럽조제기 상태를 확인하려면 설정 페이지로 이동해야 하던 불편함 해결
- 조제 중 상태로 인해 발생하던 불필요한 오류 해결
- 일시적 응답 없음 상태에서 복구되지 않던 문제 해결
- 처방정보 전송 시 잠깐 연결끊김으로 바뀌던 문제 해결
"@

$releaseData = @{
    tag_name = $Tag
    name = $Tag
    body = $releaseBody
    draft = $true
    prerelease = $false
} | ConvertTo-Json

$headers = @{
    "Authorization" = "token $Token"
    "Accept" = "application/vnd.github.v3+json"
}

try {
    $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Method Post -Headers $headers -Body $releaseData -ContentType "application/json"
    Write-Host "드래프트 릴리즈가 성공적으로 생성되었습니다!" -ForegroundColor Green
    Write-Host "릴리즈 URL: $($response.html_url)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "다음 단계:" -ForegroundColor Yellow
    Write-Host "1. GitHub에서 릴리즈를 확인하고 검토하세요" -ForegroundColor Yellow
    Write-Host "2. 필요시 내용을 수정하세요" -ForegroundColor Yellow
    Write-Host "3. 준비가 되면 'Publish release'를 클릭하여 공개하세요" -ForegroundColor Yellow
} catch {
    Write-Host "오류 발생: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "상세: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
    exit 1
}









