const {
    DEFAULT_PARSER,
    normalizeText,
    normalizeLines,
    extractPatientName,
    extractPrescriptionNo,
    extractReceiptDate,
    finalizeBagParseResult,
    isTestPdf,
    cleanDrugName,
    DRUG_KEYWORD_PATTERN
} = require('./pdfBagParser');

const HEADER_VOCAB = [
    '약품명', '약품', '투약량', '1회투약량', '횟수', '1일투여횟수', '일수', '총투약일수', '총투', '용량', '회', '분'
];
const DEFAULT_FOOTER_KEYWORDS = ['본인의 약', '처방조제된 약', '복약안내', '처방조제'];
const DEFAULT_STOP_PATTERNS = ['^\\[', '정씩\\d+회', '^적색', '^흰색', '^분홍', '^연분홍', '^분홍색', '^연분홍색'];

function compactLine(line) {
    return String(line || '').replace(/\s+/g, '');
}

function countHeaderScore(line) {
    const compact = compactLine(line);
    return HEADER_VOCAB.filter((kw) => compact.includes(kw.replace(/\s+/g, ''))).length;
}

function findBestHeaderLine(lines, minScore = 2) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
        const score = countHeaderScore(lines[i]);
        if (score >= minScore && score >= bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    return { index: bestIdx, score: bestScore, fingerprint: bestIdx >= 0 ? compactLine(lines[bestIdx]) : '' };
}

function headerLineMatches(line, learned) {
    const compact = compactLine(line);
    if (learned.headerFingerprint && compact.includes(learned.headerFingerprint.slice(0, Math.min(8, learned.headerFingerprint.length)))) {
        return true;
    }
    return countHeaderScore(line) >= (learned.headerMinScore || 2);
}

function isFooterLine(line, footerKeywords) {
    return (footerKeywords || DEFAULT_FOOTER_KEYWORDS).some((kw) => line.includes(kw));
}

function isStopLine(line, stopPatterns) {
    return (stopPatterns || DEFAULT_STOP_PATTERNS).some((pattern) => new RegExp(pattern, 'i').test(line));
}

function isDrugCandidateLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) return false;
    if (/^[-=]+$/.test(trimmed)) return false;
    if (/^20\d{6}/.test(trimmed)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
    if (/^[0-9,.\s]+$/.test(trimmed)) return false;
    if (!/[가-힣A-Za-z]/.test(trimmed)) return false;
    if (!/\d/.test(trimmed)) return false;
    if (/의원|병원|약국|조제약사|가정의학과|통증의학과/.test(trimmed)) return false;
    return true;
}

function splitTrailingNumbers(line) {
    const tokens = line.trim().split(/\s+/);
    const numericTail = [];
    while (tokens.length > 0 && /^\d+(\.\d+)?$/.test(tokens[tokens.length - 1])) {
        numericTail.unshift(parseFloat(tokens.pop()));
    }
    return {
        namePart: tokens.join(' ').trim(),
        numericTail
    };
}

function cleanGenericDrugName(raw, doseInName) {
    let name = String(raw || '').trim();
    if (doseInName) {
        name = name.replace(/(\d+\/\d+(?:\.\d+)?m?g?)$/i, '').trim();
        name = name.replace(/(\d+(?:\.\d+)?(?:mg|%)?)$/i, '').trim();
        name = name.replace(/(\d+(?:\.\d+)?)m$/i, '').trim();
    }
    name = name.replace(/[\/\\]\s*$/, '').trim();
    name = name.replace(/\s+/g, '');
    return name || String(raw || '').trim();
}

function extractDoseFromName(raw) {
    const match = String(raw || '').trim().match(/(\d+(?:\.\d+)?)(?:mg|m|%)?$/i);
    if (match) return parseFloat(match[1]);
    const slashMatch = String(raw || '').trim().match(/(\d+)\/(\d+)/);
    if (slashMatch) return parseFloat(slashMatch[1]);
    return 1;
}

function inferRowFormatFromSamples(sampleLines) {
    const tails = sampleLines.map((line) => splitTrailingNumbers(line).numericTail);
    const counts = tails.map((t) => t.length).filter((n) => n >= 2);
    if (!counts.length) return null;

    const countFreq = {};
    counts.forEach((n) => { countFreq[n] = (countFreq[n] || 0) + 1; });
    const trailingNumericCount = Number(Object.entries(countFreq).sort((a, b) => b[1] - a[1])[0][0]);

    let embedded = 0;
    sampleLines.forEach((line) => {
        const { namePart, numericTail } = splitTrailingNumbers(line);
        if (numericTail.length === trailingNumericCount && /(\d+(?:\.\d+)?(?:mg|m|%)?|\d+\/\d+)/i.test(namePart)) {
            embedded++;
        }
    });

    return {
        trailingNumericCount,
        doseEmbeddedInName: trailingNumericCount <= 3 && embedded >= Math.max(1, Math.floor(sampleLines.length / 2)),
        explicitTotalColumn: trailingNumericCount >= 3
    };
}

function mapTrailingToDosage(namePart, numericTail, rowFormat) {
    if (!numericTail.length) return null;

    const count = rowFormat.trailingNumericCount || numericTail.length;
    const nums = numericTail.slice(-count);
    if (nums.length < 2) return null;

    if (count >= 4) {
        return {
            pill_name: cleanGenericDrugName(namePart, rowFormat.doseEmbeddedInName),
            volume: nums[0],
            daily: nums[1],
            period: nums[2],
            total: nums[3]
        };
    }

    if (count === 3) {
        if (rowFormat.doseEmbeddedInName) {
            return {
                pill_name: cleanGenericDrugName(namePart, true),
                volume: extractDoseFromName(namePart),
                daily: nums[0],
                period: nums[1],
                total: nums[2]
            };
        }
        return {
            pill_name: cleanGenericDrugName(namePart, false),
            volume: nums[0],
            daily: nums[1],
            period: nums[2],
            total: nums[0] * nums[1] * nums[2]
        };
    }

    if (count === 2) {
        return {
            pill_name: cleanGenericDrugName(namePart, rowFormat.doseEmbeddedInName),
            volume: rowFormat.doseEmbeddedInName ? extractDoseFromName(namePart) : nums[0],
            daily: nums[0],
            period: nums[1],
            total: nums[0] * nums[1]
        };
    }

    return null;
}

function parseGenericRow(line, rowFormat) {
    const { namePart, numericTail } = splitTrailingNumbers(line);
    if (!namePart || !numericTail.length) return null;
    return mapTrailingToDosage(namePart, numericTail, rowFormat);
}

function collectRowsAfterHeader(lines, region, rowFormat) {
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (headerLineMatches(lines[i], region)) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) return [];

    const items = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (isFooterLine(line, region.footerKeywords)) break;
        if (isStopLine(line, region.stopPatterns)) break;
        if (!isDrugCandidateLine(line)) continue;

        const parsed = parseGenericRow(line, rowFormat);
        if (!parsed || !parsed.pill_name || !parsed.daily || !parsed.period) continue;

        items.push({
            pill_code: '',
            pill_name: parsed.pill_name,
            volume: parsed.volume,
            daily: parsed.daily,
            period: parsed.period,
            total: parsed.total || parsed.volume * parsed.daily * parsed.period,
            line_number: items.length + 1
        });
    }
    return items;
}

function inferMatrixColumnOrder(headerLine) {
    const compact = compactLine(headerLine);
    const specs = [
        { key: 'period', tokens: ['일수', '총투약일수', '총투'] },
        { key: 'daily', tokens: ['횟수', '1일투여횟수'] },
        { key: 'volume', tokens: ['투약량', '1회투약량'] }
    ];

    const positions = [];
    specs.forEach((spec) => {
        let best = -1;
        spec.tokens.forEach((token) => {
            const idx = compact.indexOf(token);
            if (idx >= 0 && (best < 0 || idx < best)) best = idx;
        });
        if (best >= 0) positions.push({ key: spec.key, pos: best });
    });

    if (positions.length < 2) {
        return ['period', 'daily', 'volume'];
    }

    return positions.sort((a, b) => a.pos - b.pos).map((p) => p.key);
}

function collectMatrixBeforeHeader(lines, region) {
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (headerLineMatches(lines[i], region)) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) return [];

    const columnOrder = region.matrixColumnOrder || inferMatrixColumnOrder(lines[headerIdx]);
    let idx = headerIdx - 1;
    const drugRaw = [];
    while (idx >= 0 && !/^\d+(\.\d+)?$/.test(lines[idx])) {
        if (isDrugCandidateLine(lines[idx]) || /[가-힣]/.test(lines[idx])) {
            drugRaw.unshift(lines[idx]);
        }
        idx--;
    }

    const numericValues = [];
    while (idx >= 0 && /^\d+(\.\d+)?$/.test(lines[idx])) {
        numericValues.unshift(parseFloat(lines[idx]));
        idx--;
    }

    if (numericValues.length < 3 || drugRaw.length === 0) return [];

    const colCount = Math.floor(numericValues.length / 3);
    if (colCount < 1) return [];

    const matrix = { period: [], daily: [], volume: [] };
    const rowSize = colCount;
    columnOrder.forEach((key, rowIndex) => {
        const start = rowIndex * rowSize;
        matrix[key] = numericValues.slice(start, start + rowSize);
    });

    const drugNames = [];
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    let buffer = '';
    for (const line of drugRaw) {
        buffer += line;
        if (drugKeyword.test(buffer) || /정|캡슐|시럽|현탁|로션|액|연고/.test(buffer)) {
            const cleaned = cleanDrugName(buffer);
            if (cleaned.length >= 2) drugNames.push(cleaned);
            buffer = '';
        }
    }
    if (buffer) {
        const cleaned = cleanDrugName(buffer);
        if (cleaned.length >= 2) drugNames.push(cleaned);
    }

    const count = Math.min(drugNames.length, matrix.volume.length, matrix.daily.length, matrix.period.length);
    const items = [];
    for (let i = 0; i < count; i++) {
        const volume = matrix.volume[i];
        const daily = matrix.daily[i];
        const period = matrix.period[i];
        if (!volume || !daily || !period) continue;
        items.push({
            pill_code: '',
            pill_name: drugNames[i],
            volume,
            daily,
            period,
            total: volume * daily * period,
            line_number: items.length + 1
        });
    }
    return items;
}

function collectLabeledBlocks(lines) {
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    const items = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!drugKeyword.test(line) && !/정\d|시럽|현탁|로션/.test(line)) continue;
        if (line.includes('1회투약량')) continue;

        const pillName = cleanDrugName(line);
        if (!pillName || pillName.length < 2) continue;

        let volume;
        let daily;
        let period;

        for (let j = i; j < Math.min(i + 20, lines.length); j++) {
            const scan = lines[j];
            const vol = scan.match(/1회투약량\s*(\d+(?:\.\d+)?)/);
            if (vol) volume = parseFloat(vol[1]);
            const freq = scan.match(/1일투여횟수\s*(\d+(?:\.\d+)?)/);
            if (freq) daily = parseFloat(freq[1]);
            const days = scan.match(/총투약일수\s*(\d+(?:\.\d+)?)/);
            if (days) period = parseFloat(days[1]);
            if (/^1회투약량\s*$/.test(scan) && j + 1 < lines.length) {
                const v = lines[j + 1].match(/^(\d+(?:\.\d+)?)/);
                if (v) volume = parseFloat(v[1]);
            }
            if (/^1일투여횟수\s*$/.test(scan) && j + 1 < lines.length) {
                const v = lines[j + 1].match(/^(\d+(?:\.\d+)?)/);
                if (v) daily = parseFloat(v[1]);
            }
            if (/^총투약일수\s*$/.test(scan) && j + 1 < lines.length) {
                const v = lines[j + 1].match(/^(\d+(?:\.\d+)?)/);
                if (v) period = parseFloat(v[1]);
            }
            if (volume > 0 && daily > 0 && period > 0) break;
        }

        if (!volume || !daily || !period) continue;
        const key = `${pillName}|${volume}|${daily}|${period}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
            pill_code: '',
            pill_name: pillName,
            volume,
            daily,
            period,
            total: volume * daily * period,
            line_number: items.length + 1
        });
    }
    return items;
}

function learnRowsAfterHeader(lines) {
    const header = findBestHeaderLine(lines, 2);
    if (header.index < 0) return null;

    const sampleLines = [];
    for (let i = header.index + 1; i < lines.length; i++) {
        const line = lines[i];
        if (isFooterLine(line)) break;
        if (isStopLine(line)) break;
        if (!isDrugCandidateLine(line)) continue;
        sampleLines.push(line);
    }
    if (!sampleLines.length) return null;

    const rowFormat = inferRowFormatFromSamples(sampleLines);
    if (!rowFormat) return null;

    return {
        regionType: 'rows_after_header',
        headerFingerprint: header.fingerprint,
        headerMinScore: Math.min(2, header.score),
        footerKeywords: [...DEFAULT_FOOTER_KEYWORDS],
        stopPatterns: [...DEFAULT_STOP_PATTERNS],
        rowFormat,
        sampleDrugLines: sampleLines.slice(0, 8)
    };
}

function learnMatrixBeforeHeader(lines) {
    const header = findBestHeaderLine(lines, 2);
    if (header.index < 0) return null;

    const compact = header.fingerprint;
    if (!/일수|횟수|투약/.test(compact)) return null;

    let idx = header.index - 1;
    let numericCount = 0;
    while (idx >= 0 && /^\d+(\.\d+)?$/.test(lines[idx])) {
        numericCount++;
        idx--;
    }
    if (numericCount < 3 || numericCount % 3 !== 0) return null;

    return {
        regionType: 'matrix_before_header',
        headerFingerprint: header.fingerprint,
        headerMinScore: Math.min(2, header.score),
        matrixColumnOrder: inferMatrixColumnOrder(lines[header.index]),
        footerKeywords: [...DEFAULT_FOOTER_KEYWORDS],
        stopPatterns: [...DEFAULT_STOP_PATTERNS]
    };
}

function learnLabeledBlocks(lines) {
    const joined = lines.join('\n');
    if (!/1회투약량/i.test(joined) || !/1일투여횟수/i.test(joined) || !/총투약일수/i.test(joined)) {
        return null;
    }
    return {
        regionType: 'labeled_blocks',
        headerFingerprint: '',
        headerMinScore: 0,
        footerKeywords: [...DEFAULT_FOOTER_KEYWORDS],
        stopPatterns: [...DEFAULT_STOP_PATTERNS]
    };
}

function learnStackedCompact(lines) {
    const { extractItemsStackedCompact } = require('./pdfBagParser');
    const medicines = extractItemsStackedCompact(lines);
    if (!medicines.length) return null;
    return {
        regionType: 'stacked_compact',
        headerFingerprint: '',
        headerMinScore: 0,
        footerKeywords: [...DEFAULT_FOOTER_KEYWORDS],
        stopPatterns: [...DEFAULT_STOP_PATTERNS]
    };
}

function parseWithLearnedRules(lines, learned) {
    if (!learned) return [];

    if (learned.regionType === 'stacked_compact') {
        const { extractItemsStackedCompact } = require('./pdfBagParser');
        return extractItemsStackedCompact(lines);
    }
    if (learned.regionType === 'matrix_after_header') {
        const { extractItemsPm2000Matrix } = require('./pdfBagParser');
        return extractItemsPm2000Matrix(lines);
    }
    if (learned.regionType === 'rows_after_header' || learned.strategy === 'header_table') {
        return collectRowsAfterHeader(lines, learned, learned.rowFormat || inferRowParserCompat(learned));
    }
    if (learned.regionType === 'matrix_before_header' || learned.strategy === 'column_matrix') {
        return collectMatrixBeforeHeader(lines, learned);
    }
    if (learned.regionType === 'labeled_blocks' || learned.strategy === 'label_block') {
        return collectLabeledBlocks(lines);
    }
    return [];
}

function inferRowParserCompat(learned) {
    if (learned.rowFormat) return learned.rowFormat;
    if (learned.rowParser) {
        return {
            trailingNumericCount: learned.rowParser.trailingCount,
            doseEmbeddedInName: learned.rowParser.doseInName,
            explicitTotalColumn: learned.rowParser.useExplicitTotal
        };
    }
    return { trailingNumericCount: 3, doseEmbeddedInName: true, explicitTotalColumn: true };
}

function learnPm2000MatrixAfterHeader(lines) {
    const { findUbcareTableHeaderIndex, isPm2000MatrixLayout, extractItemsPm2000Matrix } = require('./pdfBagParser');
    const headerIdx = findUbcareTableHeaderIndex(lines);
    if (headerIdx < 0 || !isPm2000MatrixLayout(lines, headerIdx)) return null;

    const medicines = extractItemsPm2000Matrix(lines);
    if (!medicines.length) return null;

    return {
        regionType: 'matrix_after_header',
        headerFingerprint: compactLine(lines[headerIdx]),
        headerMinScore: 2,
        matrixColumnOrder: ['volume', 'period', 'daily'],
        footerKeywords: [...DEFAULT_FOOTER_KEYWORDS],
        stopPatterns: [...DEFAULT_STOP_PATTERNS]
    };
}

function tryAutoGenericParse(lines) {
    const hypotheses = [
        learnPm2000MatrixAfterHeader(lines),
        learnRowsAfterHeader(lines),
        learnMatrixBeforeHeader(lines),
        learnStackedCompact(lines),
        learnLabeledBlocks(lines)
    ].filter(Boolean);

    let best = [];
    let bestLearned = null;
    for (const learned of hypotheses) {
        const meds = parseWithLearnedRules(lines, learned);
        if (meds.length > best.length) {
            best = meds;
            bestLearned = learned;
        }
    }
    return { medicines: best, learned: bestLearned };
}

function learnBagTemplate(text, fileName = '') {
    const lines = normalizeLines(text);
    const { medicines, learned } = tryAutoGenericParse(lines);
    if (!learned || !medicines.length) return null;

    return {
        templateVersion: 3,
        sourceFileName: fileName,
        registeredAt: new Date().toISOString(),
        learned,
        patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
        prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern
    };
}

function parseBagTextWithLearnedTemplate(text, template, filePath = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);
    const learned = template.learned;

    if (isTestPdf(normalized)) {
        return {
            patientName: null,
            prescriptionNo: null,
            receiptDate: null,
            medicines: [],
            parseSuccess: false,
            parserUsed: 'test_skip',
            rawText: text
        };
    }

    const patientPatterns = template.patientNamePatterns || DEFAULT_PARSER.patientNamePatterns;
    const prescriptionPattern = template.prescriptionNoPattern || DEFAULT_PARSER.prescriptionNoPattern;
    const patientName = extractPatientName(normalized, patientPatterns, lines);
    const prescriptionNo = extractPrescriptionNo(normalized, prescriptionPattern, lines);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, filePath);

    let medicines = parseWithLearnedRules(lines, learned);
    let parserUsed = `generic_${learned.regionType || learned.strategy || 'unknown'}`;

    if (!medicines.length) {
        const auto = tryAutoGenericParse(lines);
        medicines = auto.medicines;
        if (medicines.length) {
            parserUsed = `generic_auto_${auto.learned?.regionType || 'retry'}`;
        }
    }

    return finalizeBagParseResult({
        patientName,
        prescriptionNo,
        receiptDate,
        medicines,
        parserUsed,
        rawText: text
    });
}

function parseBagTextGenericAuto(text, filePath = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);

    if (isTestPdf(normalized)) {
        return finalizeBagParseResult({
            patientName: null,
            prescriptionNo: null,
            receiptDate: null,
            medicines: [],
            parserUsed: 'test_skip',
            rawText: text
        });
    }

    const patientName = extractPatientName(normalized, DEFAULT_PARSER.patientNamePatterns, lines);
    const prescriptionNo = extractPrescriptionNo(normalized, DEFAULT_PARSER.prescriptionNoPattern, lines);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, filePath);
    const { medicines, learned } = tryAutoGenericParse(lines);

    return finalizeBagParseResult({
        patientName,
        prescriptionNo,
        receiptDate,
        medicines,
        parserUsed: learned ? `generic_auto_${learned.regionType}` : 'generic_auto_none',
        rawText: text
    });
}

function scoreLearnedTemplate(text, template, filePath = '') {
    const result = parseBagTextWithLearnedTemplate(text, template, filePath);
    let score = 0;
    if (result.patientName && result.patientName !== '미확인') score += 3;
    if (result.prescriptionNo) score += 2;
    score += (result.medicines || []).length * 5;
    return { score, result };
}

module.exports = {
    learnBagTemplate,
    parseBagTextWithLearnedTemplate,
    parseBagTextGenericAuto,
    parseWithLearnedRules,
    scoreLearnedTemplate,
    tryAutoGenericParse,
    splitTrailingNumbers,
    inferRowFormatFromSamples
};
