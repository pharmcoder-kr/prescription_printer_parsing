# autosyrup_pdf_parser_step3.py
# -*- coding: utf-8 -*-
"""
AutoSyrup PDF Parser - Step 3

기능:
1. 약봉투 PDF에서 텍스트 추출
2. 환자이름, 처방번호, 약품명, 1회투약량, 1일투여횟수, 총투약일수 추출
3. 총 분주량(total_ml) 계산
4. 검증(validation)
5. 오토시럽 작업큐 JSON 파일 생성

사용 예:
    python autosyrup_pdf_parser_step3.py 5.pdf
    python autosyrup_pdf_parser_step3.py 5.pdf --queue-dir queue
    python autosyrup_pdf_parser_step3.py 5.pdf --no-debug
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def import_pdfplumber():
    try:
        import pdfplumber  # type: ignore
        return pdfplumber
    except ImportError:
        print(
            "pdfplumber가 설치되어 있지 않습니다.\n"
            "아래 명령어로 설치하세요:\n\n"
            "    pip install pdfplumber\n",
            file=sys.stderr,
        )
        sys.exit(1)


def extract_text_from_pdf(pdf_path: Path) -> str:
    pdfplumber = import_pdfplumber()

    texts: List[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text(
                x_tolerance=1,
                y_tolerance=3,
                layout=False,
            )
            if page_text:
                texts.append(page_text)

    return "\n".join(texts)


def normalize_text(text: str) -> str:
    """
    PDF 텍스트 추출 시 생기는 불필요한 공백/줄바꿈 문제를 완화한다.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")

    # '총투약일 수'처럼 중간에 들어간 공백 보정
    text = re.sub(r"총\s*투약\s*일\s*수", "총투약일수", text)
    text = re.sub(r"1\s*회\s*투약\s*량", "1회투약량", text)
    text = re.sub(r"1\s*일\s*투여\s*횟\s*수", "1일투여횟수", text)

    # 약품명 중간에 잘못 들어간 공백 보정
    # 예: 자쿠 텍스듀오건조시럽 -> 자쿠텍스듀오건조시럽
    text = re.sub(r"([가-힣A-Za-z0-9])\s+([가-힣A-Za-z0-9])(?=[가-힣A-Za-z0-9]*시럽)", r"\1\2", text)

    # 너무 많은 공백 정리
    text = re.sub(r"[ \t]+", " ", text)

    return text.strip()


def clean_drug_name(raw_name: str) -> str:
    name = raw_name.strip()

    # 앞쪽 금액/숫자/잡텍스트 제거
    name = re.sub(r"^[\d,.\-]+\s*", "", name)

    # 별표 제거
    name = name.lstrip("*").strip()

    # 괄호 이후 성분명/용량 정보 제거
    # 예: 코코페디시럽(덱시부프로 -> 코코페디시럽
    # 예: 코니톱시럽_(500mL) -> 코니톱시럽
    name = re.split(r"[\(_]", name)[0].strip()

    # 불필요한 특수문자 제거
    name = re.sub(r"[\[\]{}<>]", "", name)
    name = name.strip(" _-")

    # 공백 제거
    name = re.sub(r"\s+", "", name)

    return name


def extract_patient_name(text: str) -> Optional[str]:
    """
    예:
    테스트(만 39세/남)
    테스트(만 39세/남) 테스트
    """
    match = re.search(r"([가-힣A-Za-z]{2,20})\s*\(\s*만\s*\d+\s*세\s*/\s*[남여]\s*\)", text)
    if match:
        return match.group(1).strip()

    # fallback: 첫 줄에서 괄호 전까지
    first_line = text.splitlines()[0].strip() if text.splitlines() else ""
    fallback = re.match(r"([가-힣A-Za-z]{2,20})", first_line)
    if fallback:
        return fallback.group(1).strip()

    return None


def extract_prescription_no(text: str) -> Optional[str]:
    """
    예:
    20260613-00004
    """
    matches = re.findall(r"\b(20\d{6}-\d{4,6})\b", text)
    if not matches:
        return None

    # 보통 더 긴 번호가 실제 처방번호일 가능성이 높다.
    # 예: 20260613-0001 보다 20260613-00004 선호
    matches = sorted(matches, key=lambda x: len(x), reverse=True)
    return matches[0]


def extract_items(text: str) -> List[Dict[str, Any]]:
    """
    약품명과 용법이 같은 줄 또는 가까운 위치에 있는 현재 약봉투 양식 기준 추출.

    예:
    어린이타이레놀현탁액( 1회투약량 6 1일투여횟수 3 총투약일수 5
    자쿠텍스듀오건조시럽228. 1회투약량 7 1일투여횟수 3 총투약일수 5
    """

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    items: List[Dict[str, Any]] = []
    seen_keys = set()

    # 약품명 후보 키워드
    drug_keyword_pattern = r"(?:시럽|현탁액|건조시럽|시럽용분말|액)"

    # 같은 줄에 약품명 + 용법이 같이 있는 경우
    same_line_pattern = re.compile(
        rf"(?P<drug>[^\\n]*?{drug_keyword_pattern}[^\\n]*?)\s+"
        r"1회투약량\s*(?P<dose>\d+(?:\.\d+)?)\s*"
        r"1일투여횟수\s*(?P<freq>\d+(?:\.\d+)?)\s*"
        r"총투약일수\s*(?P<days>\d+(?:\.\d+)?)"
    )

    for line in lines:
        for match in same_line_pattern.finditer(line):
            raw_drug_name = match.group("drug")
            drug_name = clean_drug_name(raw_drug_name)

            if not drug_name:
                continue

            dose = float(match.group("dose"))
            freq = float(match.group("freq"))
            days = float(match.group("days"))
            total_ml = round(dose * freq * days, 3)

            key = (drug_name, dose, freq, days)
            if key in seen_keys:
                continue
            seen_keys.add(key)

            items.append(
                {
                    "drug_name": drug_name,
                    "dose_per_once": dose,
                    "times_per_day": freq,
                    "days": days,
                    "total_ml": total_ml,
                }
            )

    return items


def validate_result(result: Dict[str, Any]) -> Dict[str, Any]:
    warnings: List[str] = []

    if not result.get("patient_name"):
        warnings.append("환자이름을 찾지 못했습니다.")

    if not result.get("prescription_no"):
        warnings.append("처방번호를 찾지 못했습니다.")

    items = result.get("items", [])

    if not items:
        warnings.append("추출된 약품이 없습니다.")

    for index, item in enumerate(items, start=1):
        drug_name = item.get("drug_name", "")
        dose = item.get("dose_per_once")
        freq = item.get("times_per_day")
        days = item.get("days")
        total_ml = item.get("total_ml")

        if not drug_name:
            warnings.append(f"{index}번째 약품명이 비어 있습니다.")

        if dose is None or dose <= 0:
            warnings.append(f"{index}번째 약품의 1회투약량이 비정상입니다.")

        if freq is None or freq <= 0:
            warnings.append(f"{index}번째 약품의 1일투여횟수가 비정상입니다.")

        if days is None or days <= 0:
            warnings.append(f"{index}번째 약품의 총투약일수가 비정상입니다.")

        if total_ml is None or total_ml <= 0:
            warnings.append(f"{index}번째 약품의 총분주량이 비정상입니다.")

        # MVP 단계 안전장치: 너무 큰 용량은 확인 필요
        if isinstance(total_ml, (int, float)) and total_ml > 200:
            warnings.append(f"{index}번째 약품의 총분주량이 200mL를 초과합니다: {total_ml}mL")

    return {
        "ok": len(warnings) == 0,
        "warnings": warnings,
    }


def parse_pdf(pdf_path: Path, include_debug: bool = True) -> Dict[str, Any]:
    raw_text = extract_text_from_pdf(pdf_path)
    normalized_text = normalize_text(raw_text)

    result: Dict[str, Any] = {
        "source_file": str(pdf_path),
        "patient_name": extract_patient_name(normalized_text),
        "prescription_no": extract_prescription_no(normalized_text),
        "items": extract_items(normalized_text),
    }

    result["validation"] = validate_result(result)

    if include_debug:
        result["debug"] = {
            "drug_count": len(result["items"]),
            "raw_text": raw_text,
            "normalized_text": normalized_text,
        }

    return result


def make_queue_job(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """
    오토시럽 본체/PC Agent가 사용할 작업큐 형태로 변환.
    """
    now = datetime.now().isoformat(timespec="seconds")

    return {
        "type": "autosyrup_dispense_job",
        "created_at": now,
        "status": "pending",
        "patient_name": parsed.get("patient_name"),
        "prescription_no": parsed.get("prescription_no"),
        "items": [
            {
                "drug_name": item["drug_name"],
                "volume_ml": item["total_ml"],
                "dose_per_once": item["dose_per_once"],
                "times_per_day": item["times_per_day"],
                "days": item["days"],
            }
            for item in parsed.get("items", [])
        ],
        "validation": parsed.get("validation", {}),
        "source_file": parsed.get("source_file"),
    }


def save_queue_job(queue_job: Dict[str, Any], queue_dir: Path) -> Path:
    queue_dir.mkdir(parents=True, exist_ok=True)

    prescription_no = queue_job.get("prescription_no") or "no_prescription_no"
    patient_name = queue_job.get("patient_name") or "unknown_patient"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    safe_prescription_no = re.sub(r"[^0-9A-Za-z가-힣_-]", "_", str(prescription_no))
    safe_patient_name = re.sub(r"[^0-9A-Za-z가-힣_-]", "_", str(patient_name))

    filename = f"{timestamp}_{safe_prescription_no}_{safe_patient_name}.json"
    output_path = queue_dir / filename

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(queue_job, f, ensure_ascii=False, indent=2)

    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description="AutoSyrup 약봉투 PDF 파서 Step 3")
    parser.add_argument("pdf_path", help="분석할 약봉투 PDF 경로")
    parser.add_argument("--queue-dir", default="queue", help="작업큐 JSON 저장 폴더. 기본값: queue")
    parser.add_argument("--no-debug", action="store_true", help="debug 텍스트 출력 제외")
    parser.add_argument("--print-parsed", action="store_true", help="작업큐가 아니라 파싱 원본 결과를 출력")
    parser.add_argument("--no-save", action="store_true", help="작업큐 JSON 파일을 저장하지 않음")

    args = parser.parse_args()

    pdf_path = Path(args.pdf_path)
    if not pdf_path.exists():
        print(f"파일을 찾을 수 없습니다: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    parsed = parse_pdf(pdf_path, include_debug=not args.no_debug)
    queue_job = make_queue_job(parsed)

    if args.print_parsed:
        print(json.dumps(parsed, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(queue_job, ensure_ascii=False, indent=2))

    if not args.no_save:
        output_path = save_queue_job(queue_job, Path(args.queue_dir))
        print(f"\n작업큐 JSON 저장 완료: {output_path}")


if __name__ == "__main__":
    main()
