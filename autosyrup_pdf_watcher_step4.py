# autosyrup_pdf_watcher_step4.py
# -*- coding: utf-8 -*-
"""
AutoSyrup PDF Watcher - Step 4

기능:
1. 지정한 폴더를 감시
2. 새 PDF 파일이 생기면 자동 파싱
3. 오토시럽 작업큐 JSON 생성
4. 처리 완료 PDF는 processed 폴더로 이동
5. 실패 PDF는 failed 폴더로 이동

설치:
    pip install pdfplumber watchdog

사용 예:
    python autosyrup_pdf_watcher_step4.py --watch-dir incoming --queue-dir queue

권장 폴더 구조:
    prescription/
      incoming/     <- PDF가 들어오는 폴더
      queue/        <- 오토시럽 작업큐 JSON 저장
      processed/    <- 정상 처리된 PDF 이동
      failed/       <- 실패한 PDF 이동
"""

import argparse
import json
import re
import shutil
import sys
import time
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


def import_watchdog():
    try:
        from watchdog.events import FileSystemEventHandler  # type: ignore
        from watchdog.observers import Observer  # type: ignore
        return FileSystemEventHandler, Observer
    except ImportError:
        print(
            "watchdog가 설치되어 있지 않습니다.\n"
            "아래 명령어로 설치하세요:\n\n"
            "    pip install watchdog\n",
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
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")

    text = re.sub(r"총\s*투약\s*일\s*수", "총투약일수", text)
    text = re.sub(r"1\s*회\s*투약\s*량", "1회투약량", text)
    text = re.sub(r"1\s*일\s*투여\s*횟\s*수", "1일투여횟수", text)

    text = re.sub(r"([가-힣A-Za-z0-9])\s+([가-힣A-Za-z0-9])(?=[가-힣A-Za-z0-9]*시럽)", r"\1\2", text)
    text = re.sub(r"[ \t]+", " ", text)

    return text.strip()


def clean_drug_name(raw_name: str) -> str:
    name = raw_name.strip()
    name = re.sub(r"^[\d,.\-]+\s*", "", name)
    name = name.lstrip("*").strip()
    name = re.split(r"[\(_]", name)[0].strip()
    name = re.sub(r"[\[\]{}<>]", "", name)
    name = name.strip(" _-")
    name = re.sub(r"\s+", "", name)
    return name


def extract_patient_name(text: str) -> Optional[str]:
    match = re.search(r"([가-힣A-Za-z]{2,20})\s*\(\s*만\s*\d+\s*세\s*/\s*[남여]\s*\)", text)
    if match:
        return match.group(1).strip()

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines:
        fallback = re.match(r"([가-힣A-Za-z]{2,20})", lines[0])
        if fallback:
            return fallback.group(1).strip()

    return None


def extract_prescription_no(text: str) -> Optional[str]:
    matches = re.findall(r"\b(20\d{6}-\d{4,6})\b", text)
    if not matches:
        return None

    matches = sorted(matches, key=lambda x: len(x), reverse=True)
    return matches[0]


def extract_items(text: str) -> List[Dict[str, Any]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    items: List[Dict[str, Any]] = []
    seen_keys = set()

    drug_keyword_pattern = r"(?:시럽|현탁액|건조시럽|시럽용분말|액)"

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

        if isinstance(total_ml, (int, float)) and total_ml > 200:
            warnings.append(f"{index}번째 약품의 총분주량이 200mL를 초과합니다: {total_ml}mL")

    return {
        "ok": len(warnings) == 0,
        "warnings": warnings,
    }


def parse_pdf(pdf_path: Path, include_debug: bool = False) -> Dict[str, Any]:
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
    now = datetime.now().isoformat(timespec="seconds")

    return {
        "type": "autosyrup_dispense_job",
        "created_at": now,
        "status": "pending" if parsed.get("validation", {}).get("ok") else "needs_review",
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


def safe_filename(value: Any) -> str:
    text = str(value or "unknown")
    return re.sub(r"[^0-9A-Za-z가-힣_-]", "_", text)


def save_queue_job(queue_job: Dict[str, Any], queue_dir: Path) -> Path:
    queue_dir.mkdir(parents=True, exist_ok=True)

    prescription_no = safe_filename(queue_job.get("prescription_no") or "no_prescription_no")
    patient_name = safe_filename(queue_job.get("patient_name") or "unknown_patient")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    filename = f"{timestamp}_{prescription_no}_{patient_name}.json"
    output_path = queue_dir / filename

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(queue_job, f, ensure_ascii=False, indent=2)

    return output_path


def wait_until_file_ready(path: Path, timeout_sec: int = 10) -> bool:
    """
    PDF가 아직 생성 중일 수 있으므로 파일 크기가 안정될 때까지 기다린다.
    """
    start = time.time()
    last_size = -1
    stable_count = 0

    while time.time() - start < timeout_sec:
        if not path.exists():
            time.sleep(0.3)
            continue

        current_size = path.stat().st_size

        if current_size > 0 and current_size == last_size:
            stable_count += 1
            if stable_count >= 3:
                return True
        else:
            stable_count = 0

        last_size = current_size
        time.sleep(0.5)

    return False


def move_file_with_unique_name(src: Path, dst_dir: Path) -> Path:
    dst_dir.mkdir(parents=True, exist_ok=True)

    dst = dst_dir / src.name
    if not dst.exists():
        shutil.move(str(src), str(dst))
        return dst

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = dst_dir / f"{src.stem}_{timestamp}{src.suffix}"
    shutil.move(str(src), str(dst))
    return dst


def process_pdf(
    pdf_path: Path,
    queue_dir: Path,
    processed_dir: Path,
    failed_dir: Path,
    include_debug: bool = False,
    move_after_process: bool = True,
) -> None:
    print(f"\n[감지] PDF 발견: {pdf_path}")

    if not wait_until_file_ready(pdf_path):
        print(f"[실패] 파일 생성이 완료되지 않았거나 읽을 수 없습니다: {pdf_path}")
        if move_after_process and pdf_path.exists():
            moved = move_file_with_unique_name(pdf_path, failed_dir)
            print(f"[이동] failed 폴더로 이동: {moved}")
        return

    try:
        parsed = parse_pdf(pdf_path, include_debug=include_debug)
        queue_job = make_queue_job(parsed)
        output_path = save_queue_job(queue_job, queue_dir)

        print(f"[완료] 작업큐 생성: {output_path}")
        print(f"[환자] {queue_job.get('patient_name')}")
        print(f"[처방번호] {queue_job.get('prescription_no')}")
        print(f"[상태] {queue_job.get('status')}")

        for index, item in enumerate(queue_job.get("items", []), start=1):
            print(f"  {index}. {item['drug_name']} / {item['volume_ml']}mL")

        warnings = queue_job.get("validation", {}).get("warnings", [])
        if warnings:
            print("[주의]")
            for warning in warnings:
                print(f"  - {warning}")

        if move_after_process:
            moved = move_file_with_unique_name(pdf_path, processed_dir)
            print(f"[이동] processed 폴더로 이동: {moved}")

    except Exception as exc:
        print(f"[오류] 처리 실패: {pdf_path}")
        print(f"       {exc}")

        if move_after_process and pdf_path.exists():
            moved = move_file_with_unique_name(pdf_path, failed_dir)
            print(f"[이동] failed 폴더로 이동: {moved}")


def process_existing_pdfs(
    watch_dir: Path,
    queue_dir: Path,
    processed_dir: Path,
    failed_dir: Path,
    include_debug: bool,
    move_after_process: bool,
) -> None:
    for pdf_path in sorted(watch_dir.glob("*.pdf")):
        process_pdf(
            pdf_path=pdf_path,
            queue_dir=queue_dir,
            processed_dir=processed_dir,
            failed_dir=failed_dir,
            include_debug=include_debug,
            move_after_process=move_after_process,
        )


def main() -> None:
    FileSystemEventHandler, Observer = import_watchdog()

    parser = argparse.ArgumentParser(description="AutoSyrup PDF 감시 프로그램 Step 4")
    parser.add_argument("--watch-dir", default="incoming", help="감시할 PDF 폴더. 기본값: incoming")
    parser.add_argument("--queue-dir", default="queue", help="작업큐 JSON 저장 폴더. 기본값: queue")
    parser.add_argument("--processed-dir", default="processed", help="처리 완료 PDF 이동 폴더. 기본값: processed")
    parser.add_argument("--failed-dir", default="failed", help="처리 실패 PDF 이동 폴더. 기본값: failed")
    parser.add_argument("--debug", action="store_true", help="작업큐 JSON에 debug 텍스트 포함")
    parser.add_argument("--no-move", action="store_true", help="처리 후 PDF를 이동하지 않음")
    parser.add_argument("--skip-existing", action="store_true", help="실행 전에 이미 있던 PDF는 처리하지 않음")

    args = parser.parse_args()

    watch_dir = Path(args.watch_dir)
    queue_dir = Path(args.queue_dir)
    processed_dir = Path(args.processed_dir)
    failed_dir = Path(args.failed_dir)

    watch_dir.mkdir(parents=True, exist_ok=True)
    queue_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    failed_dir.mkdir(parents=True, exist_ok=True)

    move_after_process = not args.no_move

    class PdfCreatedHandler(FileSystemEventHandler):
        def on_created(self, event):  # type: ignore
            if event.is_directory:
                return

            path = Path(event.src_path)
            if path.suffix.lower() != ".pdf":
                return

            process_pdf(
                pdf_path=path,
                queue_dir=queue_dir,
                processed_dir=processed_dir,
                failed_dir=failed_dir,
                include_debug=args.debug,
                move_after_process=move_after_process,
            )

        def on_moved(self, event):  # type: ignore
            if event.is_directory:
                return

            path = Path(event.dest_path)
            if path.suffix.lower() != ".pdf":
                return

            process_pdf(
                pdf_path=path,
                queue_dir=queue_dir,
                processed_dir=processed_dir,
                failed_dir=failed_dir,
                include_debug=args.debug,
                move_after_process=move_after_process,
            )

    print("AutoSyrup PDF Watcher Step 4 시작")
    print(f"감시 폴더: {watch_dir.resolve()}")
    print(f"작업큐 폴더: {queue_dir.resolve()}")
    print("종료하려면 Ctrl + C를 누르세요.\n")

    if not args.skip_existing:
        process_existing_pdfs(
            watch_dir=watch_dir,
            queue_dir=queue_dir,
            processed_dir=processed_dir,
            failed_dir=failed_dir,
            include_debug=args.debug,
            move_after_process=move_after_process,
        )

    observer = Observer()
    observer.schedule(PdfCreatedHandler(), str(watch_dir), recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n종료 중...")
        observer.stop()

    observer.join()


if __name__ == "__main__":
    main()
