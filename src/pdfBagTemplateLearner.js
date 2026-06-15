const {
    DEFAULT_PARSER,
    normalizeText,
    normalizeLines,
    extractPatientName,
    extractPrescriptionNo,
    extractReceiptDate,
    finalizeBagParseResult,
    isTestPdf
} = require('./pdfBagParser');

const HEADER_KEYWORDS = ['약품명', '투약량', '횟수', '일수', '총투', '1회투약량', '1일투여횟수', '총투약일수'];
const DEFAULT_FOOTER_KEYWORDS = ['본인의 약', '처방조제된 약', '복약안내'];
const DEFAULT_STOP_PATTERNS = ['^\\[', '정씩\\d+회', '^적색', '^흰색', '^분홍', '^연분홍'];

function countHeaderKeywordHits(line) {
    const compact = line.replace(/\s+/g, '');
    return HEADER_KEYWORDS.filter((kw) => compact.includes(kw.replace(/\s+/g, ''))).length;
}

function findLearnedHeaderIndex(lines, minHits = 2) {
    let bestIdx = -1;
    let bestHits = 0;
    for (let i = 0; i < lines.length; i++) {
        const hits = countHeaderKeywordHits(lines[i]);
        if (hits >= minHits && hits >= bestHits) {
            bestHits = hits;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function extractHeaderKeywords(line) {
    const compact = line.replace(/\s+/g, '');
    return HEADER_KEYWORDS.filter((kw) => compact.includes(kw.replace(/\s+/g, '')));
}

function isFooterLine(line, footerKeywords) {
    return footerKeywords.some((kw) => line.includes(kw));
}

function isStopLine(line, stopPatterns) {
    return stopPatterns.some((pattern) => new RegExp(pattern, 'i').test(line));
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
    if (/의원|병원|약국|조제약사/.test(trimmed)) return false;
    return true;
}

function cleanLearnedDrugName(raw, doseInName) {
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

function parseTrailingNumberRow(line, rowParser) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const fourNums = trimmed.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/);
    if (fourNums && rowParser.trailingCount >= 4) {
        const namePart = fourNums[1].trim();
        return {
            pill_name: cleanLearnedDrugName(namePart, rowParser.doseInName),
            volume: parseFloat(fourNums[2]),
            daily: parseFloat(fourNums[3]),
            period: parseFloat(fourNums[4]),
            total: parseFloat(fourNums[5])
        };
    }

    const threeNums = trimmed.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/);
    if (!threeNums) return null;

    const namePart = threeNums[1].trim();
    if (rowParser.doseInName) {
        return {
            pill_name: cleanLearnedDrugName(namePart, true),
            volume: extractDoseFromName(namePart),
            daily: parseFloat(threeNums[2]),
            period: parseFloat(threeNums[3]),
            total: parseFloat(threeNums[4])
        };
    }

    const volume = parseFloat(threeNums[2]);
    const daily = parseFloat(threeNums[3]);
    const period = parseFloat(threeNums[4]);
    return {
        pill_name: cleanLearnedDrugName(namePart, false),
        volume,
        daily,
        period,
        total: volume * daily * period
    };
}

function inferRowParser(sampleLines) {
    let three = 0;
    let four = 0;
    let embedded = 0;

    for (const line of sampleLines) {
        if (/^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.test(line)) {
            four++;
        } else if (/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/.test(line)) {
            three++;
            const namePart = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/)[1];
            if (/(\d+(?:\.\d+)?(?:mg|m|%)?|\d+\/\d+)/i.test(namePart)) embedded++;
        }
    }

    const trailingCount = four > 0 && four >= three ? 4 : 3;
    return {
        type: 'trailing_numbers',
        trailingCount,
        doseInName: trailingCount === 3 && embedded >= Math.max(1, Math.floor(three / 2)),
        useExplicitTotal: trailingCount === 4 || three > 0
    };
}

function collectHeaderTableDrugLines(lines, headerIdx, footerKeywords, stopPatterns) {
    const sample = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (isFooterLine(line, footerKeywords)) break;
        if (isStopLine(line, stopPatterns)) break;
        if (!isDrugCandidateLine(line)) continue;
        sample.push(line);
    }
    return sample;
}

function parseHeaderTableWithRules(lines, rules) {
    const headerIdx = findLearnedHeaderIndex(lines, rules.headerMinKeywordCount || 2);
    if (headerIdx < 0) return [];

    const items = [];
    const footerKeywords = rules.footerKeywords || DEFAULT_FOOTER_KEYWORDS;
    const stopPatterns = rules.stopLinePatterns || DEFAULT_STOP_PATTERNS;

    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (isFooterLine(line, footerKeywords)) break;
        if (isStopLine(line, stopPatterns)) break;
        if (!isDrugCandidateLine(line)) continue;

        const parsed = parseTrailingNumberRow(line, rules.rowParser);
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

function findColumnMatrixHeaderIndex(lines) {
    for (let i = 0; i < lines.length; i++) {
        const compact = lines[i].replace(/\s+/g, '');
        if (/일수.*횟수.*투약량.*약품명|투약량.*횟수.*일수|일수횟수투약량약품명/.test(compact)) {
            return i;
        }
    }
    return -1;
}

function learnColumnMatrixRules(lines) {
    const headerIdx = findColumnMatrixHeaderIndex(lines);
    if (headerIdx < 0) return null;

    let idx = headerIdx - 1;
    const drugRaw = [];
    while (idx >= 0 && !/^\d+(\.\d+)?$/.test(lines[idx])) {
        drugRaw.unshift(lines[idx]);
        idx--;
    }

    const numericValues = [];
    while (idx >= 0 && /^\d+(\.\d+)?$/.test(lines[idx])) {
        numericValues.unshift(parseFloat(lines[idx]));
        idx--;
    }

    if (numericValues.length < 3) return null;

    return {
        strategy: 'column_matrix',
        headerPattern: '일수횟수투약량약품명',
        numericCount: numericValues.length,
        sampleDrugLines: drugRaw.slice(0, 8)
    };
}

function learnHeaderTableRules(lines) {
    const headerIdx = findLearnedHeaderIndex(lines, 2);
    if (headerIdx < 0) return null;

    const footerKeywords = [...DEFAULT_FOOTER_KEYWORDS];
    const sampleDrugLines = collectHeaderTableDrugLines(lines, headerIdx, footerKeywords, DEFAULT_STOP_PATTERNS);
    if (!sampleDrugLines.length) return null;

    const rowParser = inferRowParser(sampleDrugLines);
    return {
        strategy: 'header_table',
        headerKeywords: extractHeaderKeywords(lines[headerIdx]),
        headerMinKeywordCount: Math.min(2, extractHeaderKeywords(lines[headerIdx]).length),
        footerKeywords,
        stopLinePatterns: DEFAULT_STOP_PATTERNS,
        rowParser,
        sampleDrugLines: sampleDrugLines.slice(0, 8)
    };
}

function learnLabelBlockRules(lines) {
    const joined = lines.join('\n');
    if (!/1회투약량/i.test(joined) || !/1일투여횟수/i.test(joined) || !/총투약일수/i.test(joined)) {
        return null;
    }
    return {
        strategy: 'label_block',
        labels: ['1회투약량', '1일투여횟수', '총투약일수']
    };
}

function learnBagTemplate(text, fileName = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);

    const candidates = [
        learnHeaderTableRules(lines),
        learnColumnMatrixRules(lines),
        learnLabelBlockRules(lines)
    ].filter(Boolean);

    let bestRules = null;
    let bestMedicines = [];

    for (const rules of candidates) {
        const medicines = parseWithLearnedRules(lines, rules);
        if (medicines.length > bestMedicines.length) {
            bestMedicines = medicines;
            bestRules = rules;
        }
    }

    if (!bestRules || !bestMedicines.length) {
        return null;
    }

    return {
        templateVersion: 2,
        sourceFileName: fileName,
        registeredAt: new Date().toISOString(),
        learned: bestRules,
        patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
        prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern
    };
}

function parseWithLearnedRules(lines, rules) {
    if (!rules) return [];

    switch (rules.strategy) {
        case 'header_table':
            return parseHeaderTableWithRules(lines, rules);
        case 'column_matrix': {
            const { extractItemsColumnTable } = require('./pdfBagParser');
            return extractItemsColumnTable(lines);
        }
        case 'label_block': {
            const { extractItemsPerDrugBlock, extractItemsInline } = require('./pdfBagParser');
            const block = extractItemsPerDrugBlock(lines);
            return block.length ? block : extractItemsInline(lines);
        }
        default:
            return [];
    }
}

function parseBagTextWithLearnedTemplate(text, template, filePath = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);
    const rules = template.learned;

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
    const prescriptionNo = extractPrescriptionNo(normalized, prescriptionPattern);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, filePath);
    const medicines = parseWithLearnedRules(lines, rules);

    return finalizeBagParseResult({
        patientName,
        prescriptionNo,
        receiptDate,
        medicines,
        parserUsed: `learned_${rules.strategy}`,
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
    parseWithLearnedRules,
    scoreLearnedTemplate,
    findLearnedHeaderIndex,
    inferRowParser
};
