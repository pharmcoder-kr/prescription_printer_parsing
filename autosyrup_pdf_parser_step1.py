# autosyrup_pdf_parser_step1.py
# 목적: 약봉투 PDF에서 환자이름, 약품명, 1회투약량, 1일투여횟수, 총투약일수를 추출합니다.
# 설치 필요: pip install pdfplumber

import re
import json
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional

import pdfplumber


DOSE_PATTERN = re.compile(
    r"1회투약량\s*(?P<dose>\d+(?:\.\d+)?)\s*"
    r"1일투여횟수\s*(?P<freq>\d+(?:\.\d+)?)\s*"
    r"총투약일수\s*(?P<days>\d+(?:\.\d+)?)"
)

PATIENT_PATTERN = re.compile(r"^(?P<name>.+?)\(만\s*\d+세\s*/\s*[남여]\)")

# 약품명 후보로 볼 키워드. 필요하면 현장에서 계속 추가하면 됩니다.
DRUG_KEYWORDS = [
    "시럽",
    "현탁액",
    "건조시럽",
    "액",
]

# 약품명에서 잘라낼 가능성이 높은 부가정보 키워드
CUT_WORDS = [
    "1회투약량",
    "실온보관",
    "차광보관",
    "건소보관",   # 샘플 PDF 오타/추출 형태 대응
    "건조보관",
    "냉장보관",
    "보관",
    "적색 시럽제",
    "투명 시럽제",
    "백색 시럽제",
    "무색 시럽제",
    "미황색 시럽용 분말",
]


def extract_text_from_pdf(pdf_path: str) -> str:
    """PDF에서 텍스트를 추출합니다. 좌표 기반 추출이 아니라 줄 단위 텍스트 추출입니다."""
    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF 파일을 찾을 수 없습니다: {pdf_path}")

    texts: List[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            texts.append(text)
    return "\n".join(texts)


def clean_drug_name(raw: str) -> str:
    """약품명 문자열에서 괄호, 용량, 보관정보 등 불필요한 부분을 정리합니다."""
    name = raw.strip()

    for word in CUT_WORDS:
        if word in name:
            name = name.split(word)[0].strip()

    # 앞쪽 별표 제거
    name = name.lstrip("* ").strip()

    # 뒤쪽 괄호 이후 정보 제거: 예) 코니톱시럽_(500mL) -> 코니톱시럽_
    name = re.sub(r"\(.*$", "", name).strip()

    # 뒤쪽 용량/숫자성 꼬리 제거: 예) 자쿠텍스듀오건조시럽228. -> 자쿠텍스듀오건조시럽
    # 단, 제품명 중 숫자가 포함될 수 있으므로 '시럽' 뒤 숫자 꼬리만 보수적으로 제거합니다.
    name = re.sub(r"(시럽)\s*\d+\.?$", r"\1", name).strip()

    # 의미 없는 기호 정리
    name = name.rstrip("_ .,").strip()
    return name


def is_drug_line(line: str) -> bool:
    """해당 줄이 약품명 줄인지 판단합니다."""
    stripped = line.strip()
    if not stripped:
        return False

    # 용법 줄, 날짜, 금액, 숫자 줄 제외
    if "1회투약량" in stripped:
        # 약품명과 용법이 같은 줄에 있으면 약품명도 포함되어 있을 수 있으므로 제외하지 않음
        pass
    if re.fullmatch(r"[\d,\-]+", stripped):
        return False
    if stripped.startswith("복약만료일"):
        return False
    if stripped in {"V", "테스트"}:
        return False

    return any(keyword in stripped for keyword in DRUG_KEYWORDS)


def extract_patient_name(lines: List[str]) -> Optional[str]:
    """환자이름을 추출합니다. 예: 테스트(만 39세/남) -> 테스트"""
    for line in lines:
        match = PATIENT_PATTERN.search(line.strip())
        if match:
            return match.group("name").strip()
    return None


def extract_drugs_and_doses(text: str) -> List[Dict[str, Any]]:
    """약품명과 용법 정보를 추출하고 순서대로 매칭합니다."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    drugs: List[str] = []
    dose_infos: List[Dict[str, float]] = []

    for line in lines:
        # 같은 줄에 약품명 + 용법이 같이 있는 경우
        dose_match = DOSE_PATTERN.search(line)
        if dose_match:
            before_dose = line[:dose_match.start()].strip()
            if before_dose and is_drug_line(before_dose):
                drug_name = clean_drug_name(before_dose)
                if drug_name:
                    drugs.append(drug_name)

            dose_infos.append({
                "dose_per_once": float(dose_match.group("dose")),
                "times_per_day": float(dose_match.group("freq")),
                "days": float(dose_match.group("days")),
            })
            continue

        # 약품명만 따로 있는 줄
        if is_drug_line(line):
            drug_name = clean_drug_name(line)
            if drug_name:
                drugs.append(drug_name)

    # 중복 약품명 제거: 같은 줄/다음 줄 추출 과정에서 중복될 가능성 방지
    unique_drugs: List[str] = []
    for drug in drugs:
        if drug not in unique_drugs:
            unique_drugs.append(drug)

    items: List[Dict[str, Any]] = []
    count = min(len(unique_drugs), len(dose_infos))

    for i in range(count):
        dose = dose_infos[i]
        items.append({
            "drug_name": unique_drugs[i],
            "dose_per_once": dose["dose_per_once"],
            "times_per_day": dose["times_per_day"],
            "days": dose["days"],
        })

    return items


def parse_prescription_pdf(pdf_path: str) -> Dict[str, Any]:
    """약봉투 PDF 전체 파싱 함수입니다."""
    text = extract_text_from_pdf(pdf_path)
    lines = [line.strip() for line in text.splitlines() if line.strip()]

    patient_name = extract_patient_name(lines)
    items = extract_drugs_and_doses(text)

    result = {
        "patient_name": patient_name,
        "items": items,
        "debug": {
            "drug_count": len(items),
            "raw_text": text,
        }
    }
    return result


def main() -> None:
    if len(sys.argv) < 2:
        print("사용법: python autosyrup_pdf_parser_step1.py 약봉투.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    result = parse_prescription_pdf(pdf_path)

    # 실제 제품에서는 raw_text는 저장하지 않는 것이 개인정보 측면에서 더 안전합니다.
    # 여기서는 개발 디버깅을 위해 포함했습니다.
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
