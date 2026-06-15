# autosyrup_pdf_parser_step2.py
# 목적: 약봉투 PDF에서 환자명, 약품명, 1회투약량, 1일투여횟수, 총투약일수, 총분주량을 추출
# 사용법:
#   pip install pdfplumber
#   python autosyrup_pdf_parser_step2.py 5.pdf

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    print("pdfplumber가 설치되어 있지 않습니다. 먼저 아래 명령을 실행하세요:")
    print("pip install pdfplumber")
    sys.exit(1)


DRUG_KEYWORDS = [
    "시럽",
    "현탁액",
    "건조시럽",
    "액",
]

EXCLUDE_DRUG_LINES = [
    "적색 시럽제",
    "투명 시럽제",
    "백색 시럽제",
    "무색 시럽제",
    "미황색 시럽용 분말",
    "실온보관",
    "차광보관",
    "건소보관",
    "건조보관",
    "보관",
]


def extract_text_from_pdf(pdf_path: Path) -> str:
    """PDF 전체 페이지에서 텍스트를 추출한다."""
    texts = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            texts.append(text)
    return "\n".join(texts)


def normalize_text(text: str) -> str:
    """PDF 추출 텍스트에서 파싱에 방해되는 공백/깨진 표현을 정리한다."""
    text = text.replace("\r", "\n")
    text = text.replace("\x0c", "\n")
    text = text.replace("\u00a0", " ")

    # pdfplumber 추출 중 단어 사이가 이상하게 벌어지는 경우 보정
    replacements = {
        "총투약일 수": "총투약일수",
        "1일투여 횟수": "1일투여횟수",
        "1회 투약량": "1회투약량",
        "건조시 럽": "건조시럽",
        "덱시부 프로": "덱시부프로",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)

    # 줄별 앞뒤 공백 정리, 빈 줄 제거
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def extract_patient_name(text: str) -> str | None:
    """예: 테스트(만 39세/남) 에서 테스트 추출"""
    match = re.search(r"([가-힣A-Za-z0-9]+)\s*\(\s*만\s*\d+세\s*/\s*[남여]\s*\)", text)
    if match:
        return match.group(1).strip()
    return None


def extract_prescription_no(text: str) -> str | None:
    """예: 20260613-00004 형태의 처방번호 추출"""
    matches = re.findall(r"\b\d{8}-\d{4,6}\b", text)
    if not matches:
        return None
    # 보통 더 긴 번호가 실제 처방 상세번호인 경우가 많아 마지막/가장 긴 값을 우선 사용
    matches = sorted(matches, key=lambda x: (len(x), x))
    return matches[-1]


def clean_drug_name(raw_name: str) -> str:
    """약품명 후보에서 괄호/용량/불필요 기호를 정리한다."""
    name = raw_name.strip()
    name = re.sub(r"^[*\-\s]+", "", name)

    # 용법 앞부분만 남기기
    name = re.split(r"\s*1회투약량\s*", name)[0].strip()

    # 괄호 이후 성분명/포장단위 제거: 코니톱시럽_(500mL) -> 코니톱시럽
    name = re.split(r"[\(_（]", name)[0].strip()

    # 끝의 특수문자 제거
    name = re.sub(r"[_\-\s]+$", "", name)
    name = re.sub(r"\s+", "", name)
    return name


def is_drug_name_candidate(name: str) -> bool:
    if not name:
        return False
    if len(name) < 2:
        return False
    for bad in EXCLUDE_DRUG_LINES:
        if bad in name:
            return False
    return any(keyword in name for keyword in DRUG_KEYWORDS)


def find_drug_dose_rows(text: str) -> list[dict]:
    """
    약품명과 용법이 같은 줄에 있는 경우를 우선 추출한다.
    예: 어린이타이레놀현탁액( 1회투약량 6 1일투여횟수 3 총투약일수 5
    """
    rows = []
    pattern = re.compile(
        r"(?P<drug>.+?)\s+1회투약량\s*(?P<dose>\d+(?:\.\d+)?)\s*"
        r"1일투여횟수\s*(?P<freq>\d+(?:\.\d+)?)\s*"
        r"총투약일수\s*(?P<days>\d+(?:\.\d+)?)"
    )

    for line in text.splitlines():
        match = pattern.search(line)
        if not match:
            continue

        drug_name = clean_drug_name(match.group("drug"))
        if not is_drug_name_candidate(drug_name):
            continue

        dose = float(match.group("dose"))
        freq = float(match.group("freq"))
        days = float(match.group("days"))
        total_ml = dose * freq * days

        rows.append(
            {
                "drug_name": drug_name,
                "dose_per_once": dose,
                "times_per_day": freq,
                "days": days,
                "total_ml": total_ml,
                "source_line": line,
            }
        )
    return rows


def deduplicate_items(items: list[dict]) -> list[dict]:
    """
    PDF 추출 과정에서 같은 약품 줄이 2번 잡히는 경우 제거.
    약품명 + 용법 조합이 같으면 같은 항목으로 본다.
    """
    result = []
    seen = set()

    for item in items:
        key = (
            item["drug_name"],
            item["dose_per_once"],
            item["times_per_day"],
            item["days"],
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(item)

    return result


def validate_result(items: list[dict]) -> dict:
    """파싱 결과의 기본 검증 상태를 만든다."""
    warnings = []

    if not items:
        warnings.append("약품/용법 정보를 찾지 못했습니다.")

    for item in items:
        if item["dose_per_once"] <= 0:
            warnings.append(f"{item['drug_name']}: 1회투약량이 0 이하입니다.")
        if item["times_per_day"] <= 0:
            warnings.append(f"{item['drug_name']}: 1일투여횟수가 0 이하입니다.")
        if item["days"] <= 0:
            warnings.append(f"{item['drug_name']}: 총투약일수가 0 이하입니다.")
        if item["total_ml"] > 200:
            warnings.append(f"{item['drug_name']}: 총 분주량이 200mL를 초과합니다. 확인이 필요합니다.")

    return {
        "ok": len(warnings) == 0,
        "warnings": warnings,
    }


def parse_prescription_pdf(pdf_path: str | Path) -> dict:
    pdf_path = Path(pdf_path)
    raw_text = extract_text_from_pdf(pdf_path)
    normalized_text = normalize_text(raw_text)

    patient_name = extract_patient_name(normalized_text)
    prescription_no = extract_prescription_no(normalized_text)

    items = find_drug_dose_rows(normalized_text)
    items = deduplicate_items(items)

    # 사용자에게 보여줄 최종 JSON에서는 디버깅용 source_line 제거
    clean_items = []
    for item in items:
        clean_items.append(
            {
                "drug_name": item["drug_name"],
                "dose_per_once": item["dose_per_once"],
                "times_per_day": item["times_per_day"],
                "days": item["days"],
                "total_ml": item["total_ml"],
            }
        )

    validation = validate_result(clean_items)

    return {
        "patient_name": patient_name,
        "prescription_no": prescription_no,
        "items": clean_items,
        "validation": validation,
        "debug": {
            "drug_count": len(clean_items),
            "raw_text": raw_text,
            "normalized_text": normalized_text,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="AutoSyrup 약봉투 PDF 파서 Step 2")
    parser.add_argument("pdf", help="분석할 약봉투 PDF 파일 경로")
    parser.add_argument("--no-debug", action="store_true", help="debug 텍스트를 출력하지 않음")
    args = parser.parse_args()

    result = parse_prescription_pdf(args.pdf)

    if args.no_debug:
        result.pop("debug", None)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
