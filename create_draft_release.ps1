# GitHub 드래프트 릴리즈 생성 스크립트
param(
    [string]$Token = $env:GITHUB_TOKEN,
    [string]$Tag = "v1.3.24",
    [string]$Repo = "pharmcoder-kr/prescription"
)

if (-not $Token) {
    Write-Host "GitHub Personal Access Token이 필요합니다." -ForegroundColor Yellow
    Write-Host "다음 중 하나를 선택하세요:" -ForegroundColor Yellow
    Write-Host "1. 환경 변수 GITHUB_TOKEN 설정" -ForegroundColor Yellow
    Write-Host "2. 스크립트 실행 시 -Token 매개변수로 전달" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "예: .\create_draft_release.ps1 -Token 'your_token_here'" -ForegroundColor Cyan
    exit 1
}

$releaseBody = @"
## v1.3.24: 실시간 파일 감시 및 즉시 조제 시작

### 주요 변경사항
- **실시간 파일 감시**: `fs.watch`를 사용하여 파일 생성 즉시 감지
- **즉시 조제 시작**: `setTimeout` 지연 제거, `requestAnimationFrame`으로 즉시 실행
- **26초 고정 문제 해결**: 파일이 생성되는 즉시 파싱 및 조제 시작

### 수정 내용
- `setInterval` 폴링 방식에서 `fs.watch` 실시간 파일 감시로 변경
- 파일 생성 즉시 파싱 처리 (최대 2초 지연 → 즉시 처리)
- 조제 시작 시 `setTimeout` 제거, DOM 업데이트 후 즉시 실행
- `fs.watch` 실패 시 500ms 폴링으로 폴백 처리

### 기술적 세부사항
- **기존**: `setInterval`로 2초마다 폴더 스캔 (최대 2초 지연)
- **수정**: `fs.watch`로 파일 생성 이벤트 즉시 감지
- **기존**: `setTimeout(..., 50)` 또는 `setTimeout(..., 200)` 사용
- **수정**: `requestAnimationFrame`으로 DOM 업데이트 후 즉시 실행
- **결과**: 파일 생성 → 파싱 → 조제 시작까지 즉시 처리

### 해결된 문제
- 파일이 생성되어도 다음 스캔 주기까지 기다려야 하던 문제 해결
- 조제 시작이 1분 후에만 실행되던 문제 해결
- 특정 시간(26초)에만 처리되던 문제 해결
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



