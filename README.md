# 오토시럽 PDF (prescription_printer_parsing)

약봉투 PDF 처방연동 버전입니다. 기존 EMR(TXT/XML) 연동 프로그램 [`pharmcoder-kr/prescription`](https://github.com/pharmcoder-kr/prescription)과 별도로 관리됩니다.

## 주요 기능

- 약봉투 PDF 폴더 실시간 감시 및 자동 파싱
- 약봉투 양식 입력 (샘플 PDF 분석·저장)
- 약물명 기반 시럽조제기 매칭
- PM3000 / 유팜 EMR 연동도 설정에서 선택 가능

## 설치

[Releases](https://github.com/pharmcoder-kr/prescription_printer_parsing/releases)에서 `auto-syrup-pdf-setup-1.0.0.exe`를 다운로드하여 설치하세요.

## 개발

```bash
npm install
npm start
```

## 빌드

```bash
npm run build-nsis
```

생성 파일: `release/auto-syrup-pdf-setup-{version}.exe`

## 릴리즈

```bash
npm run build-nsis
node create-release.js
```
